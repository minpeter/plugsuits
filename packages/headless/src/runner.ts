import type {
  CheckpointHistory,
  CompactionAppliedDetail,
  CompactionOrchestratorCallbacks,
  ModelMessage,
} from "@ai-sdk-tool/harness";
import {
  AgentErrorCode,
  CompactionOrchestrator,
  harnessEnv,
  isContextOverflowError,
  normalizeUsageMeasurement,
  shouldContinueManualToolLoop,
} from "@ai-sdk-tool/harness";
import { emitEvent as defaultEmitEvent } from "./emit";
import { processStream } from "./stream-processor";
import { TrajectoryCollector } from "./trajectory-collector";
import type { HeadlessRunnerConfig, TrajectoryEvent } from "./types";

function createInterruptEvent(): Extract<
  TrajectoryEvent,
  { type: "interrupt" }
> {
  return {
    type: "interrupt",
    reason: "caller-abort",
    timestamp: new Date().toISOString(),
  };
}

export interface InitialUserMessage {
  content: string;
  eventContent?: string;
  originalContent?: string;
}

type HeadlessMessageHistory = CheckpointHistory;

type UsageAwareMessageHistory = HeadlessMessageHistory & {
  updateActualUsage: CheckpointHistory["updateActualUsage"];
};

type MaxOutputAwareMessageHistory = HeadlessMessageHistory & {
  getRecommendedMaxOutputTokens: CheckpointHistory["getRecommendedMaxOutputTokens"];
};

type ProcessAgentResponseResult = "completed" | "max-iterations-reached";
type HeadlessTurnOverrides =
  NonNullable<HeadlessRunnerConfig["onBeforeTurn"]> extends (
    ...args: never[]
  ) => infer TResult
    ? Awaited<TResult>
    : never;

function mergeAbortSignals(
  primary: AbortSignal | undefined,
  secondary: AbortSignal | undefined
): AbortSignal | undefined {
  if (primary && secondary) {
    return AbortSignal.any([primary, secondary]);
  }

  return primary ?? secondary;
}

function buildTurnStreamOptions(params: {
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  messages: ModelMessage[];
  turnOverrides?: HeadlessTurnOverrides;
}) {
  const { abortSignal, maxOutputTokens, messages, turnOverrides } = params;

  return {
    messages: turnOverrides?.messages ?? messages,
    abortSignal: mergeAbortSignals(abortSignal, turnOverrides?.abortSignal),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...turnOverrides,
  };
}

interface HeadlessCompactionController {
  applyReady(history: HeadlessMessageHistory): {
    applied: boolean;
    stale?: boolean;
  };
  blockAtHardLimit(
    history: HeadlessMessageHistory,
    additionalTokens: number,
    phase: "new-turn" | "intermediate-step"
  ): Promise<boolean>;
  blockIfNeeded(
    history: HeadlessMessageHistory,
    content: string
  ): Promise<boolean>;
  checkAndCompact(): Promise<boolean>;
  notifyNewUserTurn(): void;
  startSpeculative(history: HeadlessMessageHistory): void;
}

const MAX_NO_OUTPUT_RETRIES = 3;

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isNoOutputGeneratedError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("No output generated")
  );
}

function hasUsageTracking(
  history: HeadlessMessageHistory
): history is UsageAwareMessageHistory {
  return (
    typeof Reflect.get(history as object, "updateActualUsage") === "function"
  );
}

function hasRecommendedMaxOutputTokens(
  history: HeadlessMessageHistory
): history is MaxOutputAwareMessageHistory {
  return (
    typeof Reflect.get(history as object, "getRecommendedMaxOutputTokens") ===
    "function"
  );
}

function getMessagesForLLM(
  history: HeadlessMessageHistory
): Promise<ModelMessage[]> {
  return Promise.resolve(history.getMessagesForLLM());
}

function updateHistoryUsage(
  history: HeadlessMessageHistory,
  usage: NonNullable<Awaited<ReturnType<typeof processStream>>["usage"]>
): void {
  if (!hasUsageTracking(history)) {
    return;
  }

  const normalizedUsage = normalizeUsageMeasurement(usage);
  if (!normalizedUsage) {
    return;
  }

  history.updateActualUsage({
    inputTokens: normalizedUsage.inputTokens,
    outputTokens: normalizedUsage.outputTokens,
    totalTokens: normalizedUsage.totalTokens,
    updatedAt: new Date(),
  });
}

function getRecommendedMaxOutputTokens(
  history: HeadlessMessageHistory,
  messages: ModelMessage[]
): number | undefined {
  if (!hasRecommendedMaxOutputTokens(history)) {
    return undefined;
  }

  return history.getRecommendedMaxOutputTokens(messages);
}

function collectTrajectoryEvent(
  collector: TrajectoryCollector | null,
  event: TrajectoryEvent
): void {
  if (!collector) {
    return;
  }

  switch (event.type) {
    case "approval": {
      collector.addApproval(event);
      return;
    }
    case "step": {
      collector.addStep(event);
      return;
    }
    case "compaction": {
      collector.addCompaction(event);
      return;
    }
    case "interrupt": {
      collector.addInterrupt(event);
      return;
    }
    case "metadata": {
      collector.addMetadata(event);
      return;
    }
    default: {
      return;
    }
  }
}

function createEmitAndCollect(
  emitEventSink: (event: TrajectoryEvent) => void,
  collector: TrajectoryCollector | null
): (event: TrajectoryEvent) => void {
  return (event: TrajectoryEvent): void => {
    emitEventSink(event);
    collectTrajectoryEvent(collector, event);
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === "Aborted by caller";
}

function isStreamTimeoutError(
  error: unknown,
  streamTimeoutMs: number
): boolean {
  return (
    error instanceof Error &&
    error.message === `Stream response timeout after ${streamTimeoutMs}ms`
  );
}

function createNoopCompactionController(): HeadlessCompactionController {
  return {
    applyReady: () => ({ applied: false, stale: false }),
    blockAtHardLimit() {
      return Promise.resolve(false);
    },
    blockIfNeeded() {
      return Promise.resolve(false);
    },
    checkAndCompact() {
      return Promise.resolve(false);
    },
    notifyNewUserTurn() {
      return;
    },
    startSpeculative() {
      return;
    },
  };
}

async function runTodoReminderLoop(params: {
  emitAndCollect: (event: TrajectoryEvent) => void;
  enqueueUserMessage: (message: { content: string }) => Promise<void>;
  maxTodoReminders: number;
  onTodoReminder: () => Promise<{
    hasReminder: boolean;
    message: string | null;
  }>;
  processAgentResponse: () => Promise<ProcessAgentResponseResult>;
}): Promise<void> {
  let todoReminderCount = 0;

  while (true) {
    todoReminderCount += 1;
    if (todoReminderCount > params.maxTodoReminders) {
      params.emitAndCollect({
        timestamp: new Date().toISOString(),
        type: "error",
        code: AgentErrorCode.MAX_ITERATIONS,
        error: `Todo continuation safety cap reached (${params.maxTodoReminders} reminders).`,
      });
      break;
    }

    const reminder = await params.onTodoReminder();
    if (!reminder.hasReminder) {
      break;
    }

    const reminderMessage = reminder.message;
    if (!reminderMessage) {
      continue;
    }

    await params.enqueueUserMessage({ content: reminderMessage });
    const reminderRunResult = await params.processAgentResponse();
    if (reminderRunResult === "max-iterations-reached") {
      break;
    }
  }
}

export async function runHeadless(config: HeadlessRunnerConfig): Promise<void> {
  const emitEventSink = config.emitEvent ?? defaultEmitEvent;
  const trajectoryCollector = config.atifOutputPath
    ? new TrajectoryCollector()
    : null;
  const emitAndCollect = createEmitAndCollect(
    emitEventSink,
    trajectoryCollector
  );
  const isMetricsEnabled = harnessEnv.COMPACTION_DEBUG;
  let turnNumber = 0;
  let blockingStartTime: number | null = null;
  const emitMetric = isMetricsEnabled
    ? (obj: Record<string, unknown>): void => {
        process.stderr.write(
          `[compaction-metric] ${JSON.stringify({ ts: Date.now(), ...obj })}\n`
        );
      }
    : undefined;
  const streamTimeoutMs = config.streamTimeoutMs ?? 30_000;
  const maxTodoReminders = config.maxTodoReminders ?? 20;
  let totalIterationCount = 0;
  type StreamTurnResult = Awaited<ReturnType<typeof processStream>>;
  type StreamUsage = StreamTurnResult["usage"] | undefined;
  const measureUsageIfAvailable = async (
    messages: ModelMessage[]
  ): Promise<boolean> => {
    if (!(config.measureUsage && hasUsageTracking(config.messageHistory))) {
      return false;
    }

    const measured = normalizeUsageMeasurement(
      await config.measureUsage(messages)
    );
    if (!measured) {
      return false;
    }

    config.messageHistory.updateActualUsage({
      inputTokens: measured.inputTokens,
      outputTokens: measured.outputTokens,
      totalTokens: measured.totalTokens,
      updatedAt: new Date(),
    });

    emitMetric?.({
      event: "usage_probe",
      turn: turnNumber,
      inputTokens: measured.inputTokens ?? null,
      totalTokens: measured.totalTokens ?? null,
    });

    return true;
  };
  const userCompactionCallbacks = config.compactionCallbacks;
  const baseCompactionCallbacks = isMetricsEnabled
    ? {
        onApplied: (detail: CompactionAppliedDetail) => {
          console.error(
            "[compaction] Applied: context reduced, some older messages were summarized"
          );
          emitMetric?.({ event: "applied", turn: turnNumber });
          userCompactionCallbacks?.onApplied?.(detail);
        },
        onError: (message: string, error: unknown) => {
          console.error(`${message} in headless runner:`, error);
          emitMetric?.({
            event: "error",
            turn: turnNumber,
            message: String(message),
          });
          userCompactionCallbacks?.onError?.(message, error);
        },
        onRejected: () => {
          console.error(
            "[compaction] Compaction rejected: summary would not reduce tokens"
          );
          emitMetric?.({ event: "rejected", turn: turnNumber });
          userCompactionCallbacks?.onRejected?.();
        },
        onStillExceeded: () => {
          console.warn(
            "[compaction] Hard limit still exceeded after retries — some context may be lost due to small context window. Proceeding with truncated context."
          );
          emitMetric?.({ event: "still_exceeded", turn: turnNumber });
          userCompactionCallbacks?.onStillExceeded?.();
        },
      }
    : {
        onApplied: (detail: CompactionAppliedDetail) => {
          console.error(
            "[compaction] Applied: context reduced, some older messages were summarized"
          );
          userCompactionCallbacks?.onApplied?.(detail);
        },
        onError: (message: string, error: unknown) => {
          console.error(`${message} in headless runner:`, error);
          userCompactionCallbacks?.onError?.(message, error);
        },
        onRejected: () => {
          console.error(
            "[compaction] Compaction rejected: summary would not reduce tokens"
          );
          userCompactionCallbacks?.onRejected?.();
        },
        onStillExceeded: () => {
          console.warn(
            "[compaction] Hard limit still exceeded after retries — some context may be lost due to small context window. Proceeding with truncated context."
          );
          userCompactionCallbacks?.onStillExceeded?.();
        },
      };
  const metricsCompactionCallbacks: Partial<CompactionOrchestratorCallbacks> = {
    onCompactionStart: () => {
      emitMetric?.({ event: "compaction_start", turn: turnNumber });
      emitAndCollect({
        type: "compaction",
        timestamp: new Date().toISOString(),
        event: "start",
        tokensBefore: config.messageHistory.getContextUsage().used,
      });
    },
    onCompactionComplete: (
      result: Parameters<
        NonNullable<CompactionOrchestratorCallbacks["onCompactionComplete"]>
      >[0]
    ) => {
      emitMetric?.({
        event: "compaction_complete",
        turn: turnNumber,
        success: result.success,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        strategy: (result as unknown as Record<string, unknown>).strategy,
      });
      emitAndCollect({
        type: "compaction",
        timestamp: new Date().toISOString(),
        event: "complete",
        tokensBefore: result.tokensBefore ?? 0,
        tokensAfter: result.tokensAfter,
        strategy: (result as unknown as Record<string, unknown>).strategy as
          | string
          | undefined,
      });
    },
    onCompactionError: (error: unknown) => {
      emitMetric?.({
        event: "compaction_error",
        turn: turnNumber,
        error: String(error),
      });
    },
    onBlockingChange: (
      event: Parameters<
        NonNullable<CompactionOrchestratorCallbacks["onBlockingChange"]>
      >[0]
    ) => {
      let durationMs: number | undefined;
      if (!event.blocking && blockingStartTime != null) {
        durationMs = Date.now() - blockingStartTime;
      }

      if (event.blocking) {
        blockingStartTime = Date.now();
        emitMetric?.({
          event: "blocking_start",
          turn: turnNumber,
          reason: event.reason,
          tokensBefore: event.tokensBefore,
        });
      } else {
        emitMetric?.({
          event: "blocking_end",
          turn: turnNumber,
          durationMs: durationMs ?? null,
          reason: event.reason,
          tokensBefore: event.tokensBefore,
          tokensAfter: event.tokensAfter,
        });
        blockingStartTime = null;
      }

      emitAndCollect({
        type: "compaction",
        timestamp: new Date().toISOString(),
        event: "blocking_change",
        tokensBefore: event.tokensBefore ?? 0,
        tokensAfter: event.tokensAfter,
        blocking: event.blocking,
        reason: event.reason,
        durationMs,
      });
    },
    onJobStatus: (id: string, message: string, state: "clear" | "running") => {
      emitMetric?.({
        event: "job_status",
        turn: turnNumber,
        id,
        message,
        state,
      });
    },
  };
  const compactionOrchestrator = config.disableCompaction
    ? createNoopCompactionController()
    : ((() => {
        const orchestrator = new CompactionOrchestrator(config.messageHistory, {
          circuitBreaker: config.circuitBreaker,
          callbacks: {
            ...baseCompactionCallbacks,
            ...metricsCompactionCallbacks,
            onBlockingChange: (event) => {
              metricsCompactionCallbacks.onBlockingChange?.(event);
              userCompactionCallbacks?.onBlockingChange?.(event);
            },
            onCompactionComplete: (result) => {
              metricsCompactionCallbacks.onCompactionComplete?.(result);
              userCompactionCallbacks?.onCompactionComplete?.(result);
            },
            onCompactionError: (error) => {
              metricsCompactionCallbacks.onCompactionError?.(error);
              userCompactionCallbacks?.onCompactionError?.(error);
            },
            onCompactionStart: () => {
              metricsCompactionCallbacks.onCompactionStart?.();
              userCompactionCallbacks?.onCompactionStart?.();
            },
            onJobStatus: (id, message, state) => {
              metricsCompactionCallbacks.onJobStatus?.(id, message, state);
              userCompactionCallbacks?.onJobStatus?.(id, message, state);
            },
            onSpeculativeReady: () => {
              const result = orchestrator.applyReady(config.messageHistory);
              if (result.applied) {
                measureUsageAfterCompaction().catch(Boolean);
              }
              userCompactionCallbacks?.onSpeculativeReady?.();
            },
          },
        });

        return orchestrator;
      })() satisfies HeadlessCompactionController);

  let stepId = 0;

  const hasReachedMaxIterations = (): boolean => {
    totalIterationCount += 1;

    if (
      config.maxIterations === undefined ||
      totalIterationCount <= config.maxIterations
    ) {
      return false;
    }

    emitAndCollect({
      timestamp: new Date().toISOString(),
      type: "error",
      code: AgentErrorCode.MAX_ITERATIONS,
      error: `Max iterations (${config.maxIterations}) reached`,
    });
    return true;
  };

  const applyPendingMessages = (pendingMessages: ModelMessage[]): void => {
    compactionOrchestrator.applyReady(config.messageHistory);
    if (pendingMessages.length > 0) {
      config.messageHistory.addModelMessages(pendingMessages);
    }
  };

  const updateUsage = (usage: StreamUsage): void => {
    if (!usage) {
      return;
    }

    updateHistoryUsage(config.messageHistory, usage);
    if (harnessEnv.DEBUG_TOKENS) {
      const input = usage.inputTokens ?? 0;
      const output = usage.outputTokens ?? 0;
      const total = usage.totalTokens ?? (input as number) + (output as number);
      console.error(
        `[debug:headless] total_tokens=${total} (input=${input}, output=${output})`
      );
    }

    if (emitMetric) {
      const contextUsage = config.messageHistory.getContextUsage();
      emitMetric({
        event: "turn_complete",
        turn: turnNumber,
        estimatedTokens: contextUsage.used,
        source: contextUsage.source,
        contextLimit: contextUsage.limit,
        actualTokens: usage.totalTokens ?? null,
      });
    }
  };

  const runSingleTurn = async (
    phase: "new-turn" | "intermediate-step"
  ): Promise<{
    finishReason?: string;
    pendingMessages: ModelMessage[];
    shouldContinue: boolean;
    usage: StreamUsage;
  }> => {
    let pendingMessages: ModelMessage[] = [];

    const readyCompactionResult = compactionOrchestrator.applyReady(
      config.messageHistory
    );
    if (readyCompactionResult.stale) {
      startSpeculativeCompaction();
    }

    await blockAtHardContextLimit(0, phase);

    let messages = await getMessagesForLLM(config.messageHistory);
    const didProbe = await measureUsageIfAvailable(messages);
    if (didProbe) {
      await compactBeforeNextTurnIfNeeded();
      await blockAtHardContextLimit(1, phase);
      messages = await getMessagesForLLM(config.messageHistory);
    }

    startSpeculativeCompaction();
    let maxOutputTokens = getRecommendedMaxOutputTokens(
      config.messageHistory,
      messages
    );
    if (maxOutputTokens !== undefined && maxOutputTokens <= 512) {
      await blockAtHardContextLimit(1, phase);
      messages = await getMessagesForLLM(config.messageHistory);
      maxOutputTokens = Math.max(
        512,
        getRecommendedMaxOutputTokens(config.messageHistory, messages) ?? 512
      );
    }
    let overflowRetried = false;
    let noOutputRetryCount = 0;
    const executeStream = async (
      streamMessages: ModelMessage[],
      streamMaxOutputTokens: number | undefined
    ) => {
      if (config.abortSignal?.aborted) {
        const interruptEvent = createInterruptEvent();
        emitAndCollect(interruptEvent);
        await config.onInterrupt?.(interruptEvent);
        return {
          pendingMessages,
          shouldContinue: false,
          usage: undefined,
        };
      }

      try {
        const turnOverrides = await config.onBeforeTurn?.(phase);
        const streamPromise = Promise.resolve(
          config.agent.stream(
            buildTurnStreamOptions({
              abortSignal: config.abortSignal,
              maxOutputTokens: streamMaxOutputTokens,
              messages: streamMessages,
              turnOverrides,
            })
          )
        );
        let raceTimeoutId: ReturnType<typeof setTimeout> | undefined;
        const stream = await Promise.race([
          streamPromise.finally(() => {
            if (raceTimeoutId !== undefined) {
              clearTimeout(raceTimeoutId);
            }
          }),
          new Promise<never>((_, reject) => {
            raceTimeoutId = setTimeout(() => {
              reject(
                new Error(`Stream response timeout after ${streamTimeoutMs}ms`)
              );
            }, streamTimeoutMs);

            config.abortSignal?.addEventListener(
              "abort",
              () => {
                if (raceTimeoutId !== undefined) {
                  clearTimeout(raceTimeoutId);
                }
                reject(new Error("Aborted by caller"));
              },
              { once: true }
            );
          }),
        ]);
        const nextStepId = stepId + 1;
        const processStreamResult = await processStream({
          emitEvent: emitAndCollect,
          modelId: config.modelId,
          onMessages: (msgs) => {
            pendingMessages = msgs;
          },
          stepId: nextStepId,
          shouldContinue: config.shouldContinue ?? shouldContinueManualToolLoop,
          stream,
          streamTimeoutMs,
        });
        stepId = nextStepId;
        return {
          finishReason: processStreamResult.finishReason,
          pendingMessages,
          shouldContinue: processStreamResult.shouldContinue,
          usage: processStreamResult.usage,
        };
      } catch (error) {
        if (isAbortError(error)) {
          const interruptEvent = createInterruptEvent();
          emitAndCollect(interruptEvent);
          await config.onInterrupt?.(interruptEvent);
          return {
            pendingMessages,
            shouldContinue: false,
            usage: undefined,
          };
        }

        if (isStreamTimeoutError(error, streamTimeoutMs)) {
          const timeoutError = error as Error;
          emitAndCollect({
            timestamp: new Date().toISOString(),
            type: "error",
            code: AgentErrorCode.TIMEOUT,
            error: timeoutError.message,
          });
          return {
            pendingMessages,
            shouldContinue: false,
            usage: undefined,
          };
        }

        if (!overflowRetried && isContextOverflowError(error).detected) {
          overflowRetried = true;
          await blockAtHardContextLimit(0, phase);
          const retryMessages = await getMessagesForLLM(config.messageHistory);
          const retryMaxOutput = getRecommendedMaxOutputTokens(
            config.messageHistory,
            retryMessages
          );
          return executeStream(retryMessages, retryMaxOutput);
        }

        if (
          noOutputRetryCount < MAX_NO_OUTPUT_RETRIES &&
          isNoOutputGeneratedError(error)
        ) {
          noOutputRetryCount += 1;
          await sleepMs(250 * noOutputRetryCount);
          const retryMessages = await getMessagesForLLM(config.messageHistory);
          const retryMaxOutput = getRecommendedMaxOutputTokens(
            config.messageHistory,
            retryMessages
          );
          return executeStream(retryMessages, retryMaxOutput);
        }

        throw error;
      }
    };

    return executeStream(messages, maxOutputTokens);
  };

  const blockAtHardContextLimit = async (
    additionalTokens: number,
    phase: "new-turn" | "intermediate-step"
  ): Promise<void> => {
    await compactionOrchestrator.blockAtHardLimit(
      config.messageHistory,
      additionalTokens,
      phase
    );
  };

  const waitForSpeculativeCompactionIfNeeded = async (
    content: string
  ): Promise<void> => {
    compactionOrchestrator.applyReady(config.messageHistory);
    await compactionOrchestrator.blockIfNeeded(config.messageHistory, content);
  };

  const startSpeculativeCompaction = (): void => {
    compactionOrchestrator.startSpeculative(config.messageHistory);
  };

  const measureUsageAfterCompaction = async (): Promise<void> => {
    if (!(config.measureUsage && hasUsageTracking(config.messageHistory))) {
      return;
    }
    const messages = config.messageHistory.getMessagesForLLM();
    await measureUsageIfAvailable(messages);
  };

  const compactBeforeNextTurnIfNeeded = async (): Promise<void> => {
    const didBlockingCompact = await compactionOrchestrator.checkAndCompact();
    const readyResult = compactionOrchestrator.applyReady(
      config.messageHistory
    );
    if (didBlockingCompact || readyResult.applied) {
      await measureUsageAfterCompaction();
    }
  };

  const enqueueUserMessage = async (
    message: InitialUserMessage | { content: string }
  ): Promise<void> => {
    turnNumber += 1;
    stepId += 1;
    emitAndCollect({
      type: "step",
      step_id: stepId,
      timestamp: new Date().toISOString(),
      source: "user",
      message:
        "eventContent" in message
          ? (message.eventContent ?? message.content)
          : message.content,
    });

    await waitForSpeculativeCompactionIfNeeded(message.content);
    config.messageHistory.addUserMessage(
      message.content,
      "originalContent" in message ? message.originalContent : undefined
    );
    compactionOrchestrator.notifyNewUserTurn();
  };

  const processAgentResponse =
    async (): Promise<ProcessAgentResponseResult> => {
      let phase: "new-turn" | "intermediate-step" = "new-turn";

      while (true) {
        if (hasReachedMaxIterations()) {
          return "max-iterations-reached";
        }

        const { finishReason, pendingMessages, shouldContinue, usage } =
          await runSingleTurn(phase);
        applyPendingMessages(pendingMessages);
        updateUsage(usage);
        const normalizedUsage = normalizeUsageMeasurement(usage) ?? undefined;
        Promise.resolve()
          .then(() =>
            config.onTurnComplete?.(
              config.messageHistory.getAll(),
              normalizedUsage,
              config.messageHistory.snapshot(),
              finishReason
            )
          )
          .catch((error) => {
            console.error("onTurnComplete callback failed in headless:", error);
          });
        startSpeculativeCompaction();
        await compactBeforeNextTurnIfNeeded();

        if (!shouldContinue) {
          return "completed";
        }

        phase = "intermediate-step";
      }
    };

  emitAndCollect({
    type: "metadata",
    timestamp: new Date().toISOString(),
    session_id: config.sessionId,
    agent: {
      name: "plugsuits",
      version: "1.0.0",
      model_name: config.modelId,
    },
  });

  if (config.initialUserMessage) {
    await enqueueUserMessage(config.initialUserMessage);
  }

  const initialRunResult = await processAgentResponse();

  if (initialRunResult !== "max-iterations-reached" && config.onTodoReminder) {
    await runTodoReminderLoop({
      emitAndCollect,
      enqueueUserMessage,
      maxTodoReminders,
      onTodoReminder: config.onTodoReminder,
      processAgentResponse,
    });
  }

  if (config.atifOutputPath && trajectoryCollector) {
    trajectoryCollector.writeTo(config.atifOutputPath);
  }
}
