import type {
  CheckpointHistory,
  ModelMessage,
  RunnableAgent,
} from "@ai-sdk-tool/harness";
import {
  CompactionOrchestrator,
  isContextOverflowError,
  shouldContinueManualToolLoop,
} from "@ai-sdk-tool/harness";
import { emitEvent as defaultEmitEvent } from "./emit";
import { processStream } from "./stream-processor";
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

export interface HeadlessRunnerConfig {
  agent: RunnableAgent;
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
  sessionId: string;
}

export async function runHeadless(config: HeadlessRunnerConfig): Promise<void> {
  const emitEvent = config.emitEvent ?? defaultEmitEvent;
  const isMetricsEnabled =
    process.env.COMPACTION_DEBUG === "1" ||
    process.env.COMPACTION_DEBUG === "true";
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
  type ProcessAgentResponseResult = "completed" | "max-iterations-reached";
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
  const baseCompactionCallbacks = isMetricsEnabled
    ? {
        onApplied: () => {
          console.error(
            "[compaction] Applied: context reduced, some older messages were summarized"
          );
          emitMetric?.({ event: "applied", turn: turnNumber });
        },
        onError: (message: string, error: unknown) => {
          console.error(`${message} in headless runner:`, error);
          emitMetric?.({
            event: "error",
            turn: turnNumber,
            message: String(message),
          });
        },
        onRejected: () => {
          console.error(
            "[compaction] Compaction rejected: summary would not reduce tokens"
          );
          emitMetric?.({ event: "rejected", turn: turnNumber });
        },
        onStillExceeded: () => {
          console.warn(
            "[compaction] Hard limit still exceeded after retries — some context may be lost due to small context window. Proceeding with truncated context."
          );
          emitMetric?.({ event: "still_exceeded", turn: turnNumber });
        },
      }
    : {
        onApplied: () => {
          console.error(
            "[compaction] Applied: context reduced, some older messages were summarized"
          );
        },
        onError: (message: string, error: unknown) => {
          console.error(`${message} in headless runner:`, error);
        },
        onRejected: () => {
          console.error(
            "[compaction] Compaction rejected: summary would not reduce tokens"
          );
        },
        onStillExceeded: () => {
          console.warn(
            "[compaction] Hard limit still exceeded after retries — some context may be lost due to small context window. Proceeding with truncated context."
          );
        },
      };
  const compactionOrchestrator = new CompactionOrchestrator(
    config.messageHistory,
    {
      ...baseCompactionCallbacks,
      onSpeculativeReady: () => {
        const result = compactionOrchestrator.applyReady(config.messageHistory);
        if (result.applied) {
          measureUsageAfterCompaction().catch(Boolean);
        }
      },
      ...(isMetricsEnabled
        ? {
            onCompactionStart: () => {
              emitMetric?.({ event: "compaction_start", turn: turnNumber });
            },
            onCompactionComplete: (result) => {
              emitMetric?.({
                event: "compaction_complete",
                turn: turnNumber,
                success: result.success,
                tokensBefore: result.tokensBefore,
                tokensAfter: result.tokensAfter,
                strategy: (result as unknown as Record<string, unknown>)
                  .strategy,
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
              if (event.blocking) {
                blockingStartTime = Date.now();
                emitMetric?.({
                  event: "blocking_start",
                  turn: turnNumber,
                  reason: event.reason,
                  tokensBefore: event.tokensBefore,
                });
                return;
              }

              const durationMs =
                blockingStartTime == null
                  ? null
                  : Date.now() - blockingStartTime;
              blockingStartTime = null;
              emitMetric?.({
                event: "blocking_end",
                turn: turnNumber,
                durationMs,
                reason: event.reason,
                tokensBefore: event.tokensBefore,
                tokensAfter: event.tokensAfter,
              });
            },
            onJobStatus: (
              id: string,
              message: string,
              state: "clear" | "running"
            ) => {
              emitMetric?.({
                event: "job_status",
                turn: turnNumber,
                id,
                message,
                state,
              });
            },
          }
        : {}),
    }
  );

  const hasReachedMaxIterations = (): boolean => {
    totalIterationCount += 1;

    if (
      config.maxIterations === undefined ||
      totalIterationCount <= config.maxIterations
    ) {
      return false;
    }

    emitEvent({
      timestamp: new Date().toISOString(),
      type: "error",
      sessionId: config.sessionId,
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
    if (process.env.DEBUG_TOKENS) {
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
        const processStreamResult = await processStream({
          emitEvent,
          modelId: config.modelId,
          onMessages: (msgs) => {
            pendingMessages = msgs;
          },
          sessionId: config.sessionId,
          shouldContinue: shouldContinueManualToolLoop,
          stream,
        });
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
    emitEvent({
      timestamp: new Date().toISOString(),
      type: "user",
      sessionId: config.sessionId,
      content:
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
        startSpeculativeCompaction();
        await compactBeforeNextTurnIfNeeded();

        if (!shouldContinue) {
          return "completed";
        }

        phase = "intermediate-step";
      }
    };

  if (config.initialUserMessage) {
    await enqueueUserMessage(config.initialUserMessage);
  }

  const initialRunResult = await processAgentResponse();

  if (initialRunResult === "max-iterations-reached" || !config.onTodoReminder) {
    return;
  }

  const MAX_TODO_REMINDER_ITERATIONS = 20;
  let todoReminderCount = 0;

  while (true) {
    todoReminderCount += 1;
    if (todoReminderCount > MAX_TODO_REMINDER_ITERATIONS) {
      emitEvent({
        timestamp: new Date().toISOString(),
        type: "error",
        sessionId: config.sessionId,
        error: `Todo continuation safety cap reached (${MAX_TODO_REMINDER_ITERATIONS} reminders).`,
      });
      break;
    }

    const reminder = await config.onTodoReminder();
    if (!reminder.hasReminder) {
      break;
    }

    const reminderMessage = reminder.message;
    if (!reminderMessage) {
      continue;
    }

    await enqueueUserMessage({ content: reminderMessage });
    const reminderRunResult = await processAgentResponse();
    if (reminderRunResult === "max-iterations-reached") {
      break;
    }
  }
}
