import type { MessageHistory, RunnableAgent } from "@ai-sdk-tool/harness";
import { shouldContinueManualToolLoop } from "@ai-sdk-tool/harness";
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
  let speculativeCompactionJob:
    | {
        discarded: boolean;
        prepared: Awaited<
          ReturnType<MessageHistory["prepareSpeculativeCompaction"]>
        >;
        promise: Promise<void>;
        state: "completed" | "failed" | "running";
      }
    | null = null;

  const discardSpeculativeCompactionJob = (): void => {
    if (speculativeCompactionJob) {
      speculativeCompactionJob.discarded = true;
      speculativeCompactionJob = null;
    }
  };

  const applyReadySpeculativeCompaction = (): void => {
    if (
      !speculativeCompactionJob ||
      speculativeCompactionJob.discarded ||
      speculativeCompactionJob.state !== "completed" ||
      !speculativeCompactionJob.prepared
    ) {
      return;
    }

    config.messageHistory.applyPreparedCompaction(
      speculativeCompactionJob.prepared
    );
    speculativeCompactionJob = null;
  };

  const waitForSpeculativeCompactionIfNeeded = async (
    content: string
  ): Promise<void> => {
    applyReadySpeculativeCompaction();

    if (
      !speculativeCompactionJob ||
      speculativeCompactionJob.discarded ||
      speculativeCompactionJob.state !== "running"
    ) {
      return;
    }

    if (
      !config.messageHistory.wouldExceedContextWithAdditionalMessage(content, {
        phase: "new-turn",
      })
    ) {
      return;
    }

    await speculativeCompactionJob.promise;
    applyReadySpeculativeCompaction();
  };

  const startSpeculativeCompaction = (): void => {
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
        job.prepared = await config.messageHistory.prepareSpeculativeCompaction({
          phase: "new-turn",
        });
        job.state = "completed";
      } catch (error) {
        job.state = "failed";
        console.error("Speculative compaction failed in headless runner:", error);
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

      const messages = await config.messageHistory.getMessagesForLLMAsync({
        phase,
      });
      const stream = await config.agent.stream({ messages });
      const processStreamResult = await processStream({
        emitEvent,
        modelId: config.modelId,
        onMessages: (messages) => {
          config.messageHistory.addModelMessages(messages);
        },
        sessionId: config.sessionId,
        shouldContinue: shouldContinueManualToolLoop,
        stream,
      });

      if (processStreamResult.usage) {
        config.messageHistory.updateActualUsage(processStreamResult.usage);
      }

      if (!processStreamResult.shouldContinue) {
        startSpeculativeCompaction();
        return;
      }

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
