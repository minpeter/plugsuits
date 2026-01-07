import { createInterface } from "node:readline/promises";
import { createFriendli } from "@friendliai/ai-provider";
import { ToolLoopAgent, wrapLanguageModel } from "ai";
import { MessageHistory } from "./context/message-history";
import { SYSTEM_PROMPT } from "./context/system-prompt";
import { env } from "./env";
import { renderFullStream } from "./interaction/stream-renderer";
import { trimLeadingNewlinesMiddleware } from "./middleware/trim-leading-newlines";
import { tools } from "./tools";

const DEFAULT_MODEL_ID = "zai-org/GLM-4.6";

const friendli = createFriendli({
  apiKey: env.FRIENDLI_TOKEN,
  includeUsage: true,
});

const agent = new ToolLoopAgent({
  model: wrapLanguageModel({
    model: friendli(DEFAULT_MODEL_ID),
    middleware: trimLeadingNewlinesMiddleware,
  }),
  instructions: SYSTEM_PROMPT,
  tools: {
    ...tools,
  },
  maxOutputTokens: 1024,
  providerOptions: {
    friendli: {
      // enable_thinking for hybrid reasoning models
      chat_template_kwargs: {
        enable_thinking: true,
      },
    },
  },
});

const messageHistory = new MessageHistory();

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

      messageHistory.addUserMessage(trimmed);

      const stream = await agent.stream({
        messages: messageHistory.toModelMessages(),
      });

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
