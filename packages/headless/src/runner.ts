import type {
  MessageHistory,
  ModelMessage,
  RunnableAgent,
} from "@ai-sdk-tool/harness";
import {
  estimateTokens,
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

export interface HeadlessRunnerConfig {
  agent: RunnableAgent;
  emitEvent?: (event: TrajectoryEvent) => void;
  initialUserMessage?: InitialUserMessage;
  maxIterations?: number;
  messageHistory: MessageHistory;
  modelId: string;
  onTodoReminder?: () => Promise<{
    hasReminder: boolean;
    message: string | null;
  }>;
  sessionId: string;
}

export async function runHeadless(config: HeadlessRunnerConfig): Promise<void> {
  const emitEvent = config.emitEvent ?? defaultEmitEvent;
  let globalIterationCount = 0;
  let speculativeCompactionJob: {
    discarded: boolean;
    prepared: Awaited<
      ReturnType<MessageHistory["prepareSpeculativeCompaction"]>
    >;
    promise: Promise<void>;
    state: "completed" | "failed" | "running";
  } | null = null;
  // No clear path in headless runner — if clear is introduced, add: speculativeCompactionJob = null

  const discardSpeculativeCompactionJob = (): void => {
    if (speculativeCompactionJob) {
      speculativeCompactionJob.discarded = true;
      speculativeCompactionJob = null;
    }
  };

  const applyReadySpeculativeCompaction = (): {
    applied: boolean;
    stale: boolean;
  } => {
    if (
      !speculativeCompactionJob ||
      speculativeCompactionJob.discarded ||
      speculativeCompactionJob.state !== "completed" ||
      !speculativeCompactionJob.prepared
    ) {
      return { applied: false, stale: false };
    }

    const result: {
      applied: boolean;
      reason: "applied" | "noop" | "stale" | "rejected";
    } = config.messageHistory.applyPreparedCompaction(
      speculativeCompactionJob.prepared
    );
    discardSpeculativeCompactionJob();

    if (result.reason === "stale") {
      startSpeculativeCompaction();
      return { applied: false, stale: true };
    }

    if (result.reason === "rejected") {
      console.error(
        "[compaction] Compaction rejected: summary would not reduce tokens"
      );
      return { applied: false, stale: false };
    }

    return { applied: result.reason === "applied", stale: false };
  };

  const getLatestRunningSpeculativeCompaction = (): NonNullable<
    typeof speculativeCompactionJob
  > | null => {
    if (
      speculativeCompactionJob &&
      !speculativeCompactionJob.discarded &&
      speculativeCompactionJob.state === "running"
    ) {
      return speculativeCompactionJob;
    }

    return null;
  };

  const blockAtHardContextLimit = async (
    additionalTokens: number,
    phase: "new-turn" | "intermediate-step"
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: hard-limit blocking logic requires multiple retry branches
  ): Promise<void> => {
    if (
      !config.messageHistory.isAtHardContextLimit(additionalTokens, { phase })
    ) {
      return;
    }

    // Maximum 2 blocking attempts to avoid infinite loops
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (
        !config.messageHistory.isAtHardContextLimit(additionalTokens, { phase })
      ) {
        return;
      }

      const runningJob = getLatestRunningSpeculativeCompaction();
      if (runningJob) {
        await runningJob.promise;
      } else {
        // No running job — prepare and apply directly
        const prepared =
          await config.messageHistory.prepareSpeculativeCompaction({
            phase: "new-turn",
          });

        if (prepared) {
          const result =
            config.messageHistory.applyPreparedCompaction(prepared);
          if (result.reason === "stale" && attempt === 0) {
            // Stale on direct apply — start a fresh speculative job and retry
            startSpeculativeCompaction();
            continue;
          }
        }
      }

      // Apply any completed speculative job (handles stale via re-fire inside)
      applyReadySpeculativeCompaction();
    }

    if (
      config.messageHistory.isAtHardContextLimit(additionalTokens, { phase })
    ) {
      console.warn(
        "[compaction] Hard limit still exceeded after 2 compaction attempts. Proceeding with current context."
      );
    }
  };

  const waitForSpeculativeCompactionIfNeeded = async (
    content: string
  ): Promise<void> => {
    applyReadySpeculativeCompaction();

    if (
      !config.messageHistory.isAtHardContextLimit(estimateTokens(content), {
        phase: "new-turn",
      })
    ) {
      return;
    }

    await blockAtHardContextLimit(estimateTokens(content), "new-turn");
  };

  const startSpeculativeCompaction = (): void => {
    applyReadySpeculativeCompaction();
    if (
      speculativeCompactionJob &&
      !speculativeCompactionJob.discarded &&
      speculativeCompactionJob.state !== "failed"
    ) {
      return;
    }

    if (!config.messageHistory.shouldStartSpeculativeCompactionForNextTurn()) {
      return;
    }

    discardSpeculativeCompactionJob();

    const job: NonNullable<typeof speculativeCompactionJob> = {
      discarded: false,
      prepared: null,
      promise: Promise.resolve(),
      state: "running",
    };

    job.promise = (async () => {
      try {
        job.prepared = await config.messageHistory.prepareSpeculativeCompaction(
          {
            phase: "new-turn",
          }
        );
        job.state = "completed";
      } catch (error) {
        job.state = "failed";
        console.error(
          "Speculative compaction failed in headless runner:",
          error
        );
      }
    })();

    speculativeCompactionJob = job;
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

  const processAgentResponse = async (): Promise<void> => {
    let phase: "new-turn" | "intermediate-step" = "new-turn";

    while (true) {
      globalIterationCount += 1;

      if (
        config.maxIterations !== undefined &&
        globalIterationCount > config.maxIterations
      ) {
        emitEvent({
          timestamp: new Date().toISOString(),
          type: "error",
          sessionId: config.sessionId,
          error: `Max iterations (${config.maxIterations}) reached`,
        });
        break;
      }

      let pendingMessages: ModelMessage[] = [];

      const readyCompactionResult = applyReadySpeculativeCompaction();
      if (readyCompactionResult.stale) {
        startSpeculativeCompaction();
      }

      await blockAtHardContextLimit(0, phase);

      const messages = config.messageHistory.getMessagesForLLM();
      startSpeculativeCompaction();
      const stream = await config.agent.stream({ messages });
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

      applyReadySpeculativeCompaction();
      if (pendingMessages.length > 0) {
        config.messageHistory.addModelMessages(pendingMessages);
      }

      if (processStreamResult.usage) {
        config.messageHistory.updateActualUsage(processStreamResult.usage);
      }

      if (!processStreamResult.shouldContinue) {
        startSpeculativeCompaction();
        return;
      }

      startSpeculativeCompaction();
      phase = "intermediate-step";
    }
  };

  if (config.initialUserMessage) {
    await enqueueUserMessage(config.initialUserMessage);
  }

  await processAgentResponse();

  if (!config.onTodoReminder) {
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
    await processAgentResponse();
  }
}
