import {
  type Command,
  createAgent,
  MessageHistory,
  SessionManager,
} from "@ai-sdk-tool/harness";
import { emitEvent, runHeadless } from "@ai-sdk-tool/headless";
import { createAgentTUI } from "@ai-sdk-tool/tui";
import {
  createFriendli,
  type FriendliAIProvider,
} from "@friendliai/ai-provider";
import { createEnv } from "@t3-oss/env-core";
import { defineCommand, runMain } from "citty";
import { z } from "zod";

const DEFAULT_MODEL_ID = "zai-org/GLM-5";
const DEFAULT_SYSTEM_PROMPT =
  "You are a minimal FriendliAI example agent. Be concise and helpful.";
const LOCAL_COMMANDS: Command[] = [
  {
    name: "clear",
    description: "Clear the conversation and start a new session",
    execute: () => ({
      success: true,
      action: { type: "new-session" },
      message: "Started a new session.",
    }),
  },
];

const env = createEnv({
  server: {
    FRIENDLI_BASE_URL: z.string().min(1).optional(),
    FRIENDLI_MODEL: z.string().min(1).optional(),
    FRIENDLI_TOKEN: z.string().min(1),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

function createFriendliProvider(): FriendliAIProvider {
  return createFriendli({
    apiKey: env.FRIENDLI_TOKEN,
    baseURL: env.FRIENDLI_BASE_URL || "serverless",
    includeUsage: true,
  });
}

function resolveModelId(cliModel?: string): string {
  return cliModel?.trim() || env.FRIENDLI_MODEL || DEFAULT_MODEL_ID;
}

const main = defineCommand({
  meta: {
    name: "minimal-agent",
    description: "Minimal FriendliAI-backed agent example",
  },
  args: {
    headless: {
      type: "boolean",
      description: "Run in headless JSONL mode",
    },
    model: {
      type: "string",
      description: "Override the Friendli model ID",
    },
    prompt: {
      type: "string",
      description: "User prompt (required for --headless)",
    },
  },
  async run({ args }) {
    const messageHistory = new MessageHistory();
    const sessionManager = new SessionManager("minimal-agent");
    sessionManager.initialize();
    const selectedModelId = resolveModelId(args.model);
    const friendli = createFriendliProvider();
    const agent = createAgent({
      model: friendli(selectedModelId),
      instructions: DEFAULT_SYSTEM_PROMPT,
    });

    if (args.headless) {
      const prompt = args.prompt?.trim();
      if (!prompt) {
        console.error("--headless requires --prompt <text>");
        process.exitCode = 1;
        return;
      }

      await runHeadless({
        agent,
        sessionId: sessionManager.getId(),
        emitEvent,
        initialUserMessage: {
          content: prompt,
        },
        messageHistory,
        maxIterations: 1,
        modelId: selectedModelId,
      });
      return;
    }

    await createAgentTUI({
      agent,
      commands: LOCAL_COMMANDS,
      messageHistory,
      header: {
        title: "Minimal Agent",
        get subtitle() {
          return `${selectedModelId} • ${sessionManager.getId()}`;
        },
      },
      onCommandAction: (action) => {
        if (action.type === "new-session") {
          sessionManager.initialize();
        }
      },
    });

    process.exit(0);
  },
});

runMain(main);
