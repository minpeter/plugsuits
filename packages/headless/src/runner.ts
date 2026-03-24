import type {
  CheckpointHistory,
  ModelMessage,
  RunnableAgent,
} from "@ai-sdk-tool/harness";
import {
  CompactionOrchestrator,
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

function hasUsageTracking(
  history: HeadlessMessageHistory
): history is UsageAwareMessageHistory {
  return (
    "updateActualUsage" in history &&
    typeof history.updateActualUsage === "function"
  );
}

function hasRecommendedMaxOutputTokens(
  history: HeadlessMessageHistory
): history is MaxOutputAwareMessageHistory {
  return (
    "getRecommendedMaxOutputTokens" in history &&
    typeof history.getRecommendedMaxOutputTokens === "function"
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

  history.updateActualUsage({
    completionTokens: usage.completionTokens ?? 0,
    promptTokens: usage.promptTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
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
  let totalIterationCount = 0;
  type ProcessAgentResponseResult = "completed" | "max-iterations-reached";
  type StreamTurnResult = Awaited<ReturnType<typeof processStream>>;
  type StreamUsage = StreamTurnResult["usage"];
  const compactionOrchestrator = new CompactionOrchestrator(
    config.messageHistory,
    {
      onApplied: () => {
        console.error(
          "[compaction] Applied: context reduced, some older messages were summarized"
        );
      },
      onError: (message, error) => {
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
    if (!process.env.DEBUG_TOKENS) {
      return;
    }

    const input =
      usage.promptTokens ?? (usage as Record<string, unknown>).inputTokens ?? 0;
    const output =
      usage.completionTokens ??
      (usage as Record<string, unknown>).outputTokens ??
      0;
    const total = usage.totalTokens ?? (input as number) + (output as number);
    console.error(
      `[debug:headless] total_tokens=${total} (input=${input}, output=${output})`
    );
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

    const messages = await getMessagesForLLM(config.messageHistory);
    startSpeculativeCompaction();
    const maxOutputTokens = getRecommendedMaxOutputTokens(
      config.messageHistory,
      messages
    );
    const stream = await config.agent.stream({
      messages,
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    });
    const processStreamResult = await processStream({
      emitEvent,
      modelId: config.modelId,
      onMessages: (messages) => {
        pendingMessages = messages;
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

  const enqueueUserMessage = async (
    message: InitialUserMessage | { content: string }
  ): Promise<void> => {
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

        if (!shouldContinue) {
          startSpeculativeCompaction();
          return "completed";
        }

        startSpeculativeCompaction();
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
