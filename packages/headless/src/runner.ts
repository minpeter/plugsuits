import type {
  CheckpointHistory,
  CheckpointMessage,
  CompactionAppliedDetail,
  CompactionCircuitBreaker,
  CompactionOrchestratorCallbacks,
  ModelMessage,
  RunnableAgent,
} from "@ai-sdk-tool/harness";
import {
  CompactionOrchestrator,
  harnessEnv,
  isContextOverflowError,
  shouldContinueManualToolLoop,
} from "@ai-sdk-tool/harness";
import { emitEvent as defaultEmitEvent } from "./emit";
import { processStream } from "./stream-processor";
import { TrajectoryCollector } from "./trajectory-collector";
import type { TrajectoryEvent } from "./types";

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

interface UsageMeasurement {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

type ProcessAgentResponseResult = "completed" | "max-iterations-reached";

const MAX_NO_OUTPUT_RETRIES = 3;

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isNoOutputGeneratedError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("No output generated")
  );
}

function getUsageNumber(
  usage: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function normalizeUsageMeasurement(
  usage: UsageMeasurement | null | undefined
): UsageMeasurement | null {
  if (!usage) {
    return null;
  }

  const usageRecord = usage as Record<string, unknown>;
  const inputTokens = getUsageNumber(
    usageRecord,
    "inputTokens",
    "promptTokens"
  );
  const outputTokens = getUsageNumber(
    usageRecord,
    "outputTokens",
    "completionTokens"
  );
  const totalTokens = getUsageNumber(usageRecord, "totalTokens");

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
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
    case "step": {
      collector.addStep(event);
      return;
    }
    case "compaction": {
      collector.addCompaction(event);
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

async function runTodoReminderLoop(params: {
  emitAndCollect: (event: TrajectoryEvent) => void;
  enqueueUserMessage: (message: { content: string }) => Promise<void>;
  onTodoReminder: () => Promise<{
    hasReminder: boolean;
    message: string | null;
  }>;
  processAgentResponse: () => Promise<ProcessAgentResponseResult>;
}): Promise<void> {
  const MAX_TODO_REMINDER_ITERATIONS = 20;
  let todoReminderCount = 0;

  while (true) {
    todoReminderCount += 1;
    if (todoReminderCount > MAX_TODO_REMINDER_ITERATIONS) {
      params.emitAndCollect({
        timestamp: new Date().toISOString(),
        type: "error",
        error: `Todo continuation safety cap reached (${MAX_TODO_REMINDER_ITERATIONS} reminders).`,
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

export interface HeadlessRunnerConfig {
  agent: RunnableAgent;
  atifOutputPath?: string;
  circuitBreaker?: CompactionCircuitBreaker;
  compactionCallbacks?: CompactionOrchestratorCallbacks;
  emitEvent?: (event: TrajectoryEvent) => void;
  initialUserMessage?: InitialUserMessage;
  maxIterations?: number;
  measureUsage?: (messages: ModelMessage[]) => Promise<UsageMeasurement | null>;
  messageHistory: HeadlessMessageHistory;
  modelId: string;
  onTodoReminder?: () => Promise<{
    hasReminder: boolean;
    message: string | null;
  }>;
  onTurnComplete?: (
    messages: CheckpointMessage[],
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
    }
  ) => Promise<void> | void;
  sessionId: string;
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
  let totalIterationCount = 0;
  type StreamTurnResult = Awaited<ReturnType<typeof processStream>>;
  type StreamUsage = StreamTurnResult["usage"];
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
      promptTokens: measured.inputTokens ?? null,
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
    onCompactionComplete: (result) => {
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
    onBlockingChange: (event) => {
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
  const compactionOrchestrator = new CompactionOrchestrator(
    config.messageHistory,
    {
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
          const result = compactionOrchestrator.applyReady(
            config.messageHistory
          );
          if (result.applied) {
            measureUsageAfterCompaction().catch(Boolean);
          }
          userCompactionCallbacks?.onSpeculativeReady?.();
        },
      },
    }
  );

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
      const input =
        usage.inputTokens ??
        (usage as Record<string, unknown>).promptTokens ??
        0;
      const output =
        usage.outputTokens ??
        (usage as Record<string, unknown>).completionTokens ??
        0;
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
      try {
        const stream = await config.agent.stream({
          messages: streamMessages,
          ...(streamMaxOutputTokens !== undefined
            ? { maxOutputTokens: streamMaxOutputTokens }
            : {}),
        });
        const nextStepId = stepId + 1;
        const processStreamResult = await processStream({
          emitEvent: emitAndCollect,
          modelId: config.modelId,
          onMessages: (msgs) => {
            pendingMessages = msgs;
          },
          stepId: nextStepId,
          shouldContinue: shouldContinueManualToolLoop,
          stream,
        });
        stepId = nextStepId;
        return {
          pendingMessages,
          shouldContinue: processStreamResult.shouldContinue,
          usage: processStreamResult.usage,
        };
      } catch (error) {
        if (!overflowRetried && isContextOverflowError(error)) {
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
  };

  const processAgentResponse =
    async (): Promise<ProcessAgentResponseResult> => {
      let phase: "new-turn" | "intermediate-step" = "new-turn";

      while (true) {
        if (hasReachedMaxIterations()) {
          return "max-iterations-reached";
        }

        const { pendingMessages, shouldContinue, usage } =
          await runSingleTurn(phase);
        applyPendingMessages(pendingMessages);
        updateUsage(usage);
        const normalizedUsage = normalizeUsageMeasurement(usage) ?? undefined;
        Promise.resolve(
          config.onTurnComplete?.(
            config.messageHistory.getAll(),
            normalizedUsage
          )
        ).catch((error) => {
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
      onTodoReminder: config.onTodoReminder,
      processAgentResponse,
    });
  }

  if (config.atifOutputPath && trajectoryCollector) {
    trajectoryCollector.writeTo(config.atifOutputPath);
  }
}
