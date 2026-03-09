import type { AgentStreamResult, MessageHistory } from "@ai-sdk-tool/harness";
import { shouldContinueManualToolLoop } from "@ai-sdk-tool/harness";
import { emitEvent as defaultEmitEvent } from "./emit";
import { processStream } from "./stream-processor";
import type { TrajectoryEvent } from "./types";

export interface HeadlessRunnerConfig {
  emitEvent?: (event: TrajectoryEvent) => void;
  getModelId: () => string;
  maxIterations?: number;
  messageHistory: MessageHistory;
  onTodoReminder?: () => Promise<{
    hasReminder: boolean;
    message: string | null;
  }>;
  sessionId: string;
  stream: (messages: unknown[]) => Promise<AgentStreamResult>;
}

export async function runHeadless(config: HeadlessRunnerConfig): Promise<void> {
  const emitEvent = config.emitEvent ?? defaultEmitEvent;
  const processAgentResponse = async (): Promise<void> => {
    let iterationCount = 0;

    while (true) {
      iterationCount += 1;

      if (
        config.maxIterations !== undefined &&
        iterationCount > config.maxIterations
      ) {
        emitEvent({
          timestamp: new Date().toISOString(),
          type: "error",
          sessionId: config.sessionId,
          error: `Max iterations (${config.maxIterations}) reached`,
        });
        break;
      }

      const stream = await config.stream(
        config.messageHistory.toModelMessages()
      );
      const processStreamResult = await processStream({
        emitEvent,
        modelId: config.getModelId(),
        onMessages: (messages) => {
          config.messageHistory.addModelMessages(messages);
        },
        sessionId: config.sessionId,
        shouldContinue: shouldContinueManualToolLoop,
        stream,
      });

      if (!processStreamResult.shouldContinue) {
        return;
      }
    }
  };

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

    emitEvent({
      timestamp: new Date().toISOString(),
      type: "user",
      sessionId: config.sessionId,
      content: reminderMessage,
    });

    config.messageHistory.addUserMessage(reminderMessage);
    await processAgentResponse();
  }
}
