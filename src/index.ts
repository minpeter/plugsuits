import { createInterface } from "node:readline/promises";
import { agentManager } from "./agent";
import { executeCommand, isCommand, registerCommand } from "./commands";
import { createModelCommand } from "./commands/model";
import { createRenderCommand } from "./commands/render";
import { createClearCommand } from "./commands/clear";
import { MessageHistory } from "./context/message-history";
import { renderFullStream } from "./interaction/stream-renderer";

const messageHistory = new MessageHistory();

registerCommand(
  createRenderCommand(() => ({
    model: agentManager.getModelId(),
    instructions: agentManager.getInstructions(),
    tools: agentManager.getTools(),
    messages: messageHistory.toModelMessages(),
  }))
);
registerCommand(createModelCommand());
registerCommand(createClearCommand(messageHistory));

const run = async (): Promise<void> => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const input = await rl.question("You: ");
      const trimmed = input.trim();
      if (trimmed.length === 0 || trimmed.toLowerCase() === "exit") {
        break;
      }

      if (isCommand(trimmed)) {
        try {
          const result = await executeCommand(trimmed);
          if (result?.message) {
            console.log(result.message);
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          console.error(`Command error: ${errorMessage}`);
        }
        continue;
      }

      messageHistory.addUserMessage(trimmed);

      const stream = await agentManager.stream(
        messageHistory.toModelMessages()
      );

      await renderFullStream(stream.fullStream, { showSteps: false });

      const response = await stream.response;
      messageHistory.addModelMessages(response.messages);
    }
  } finally {
    rl.close();
  }
};

run().catch((error: unknown) => {
  throw error instanceof Error ? error : new Error("Failed to run stream.");
});
