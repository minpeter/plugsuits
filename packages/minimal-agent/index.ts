import {
  type Command,
  createAgent,
  createModelSummarizer,
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
import type { LanguageModel } from "ai";
import { defineCommand, runMain } from "citty";
import { z } from "zod";

const DEFAULT_MODEL_ID = "zai-org/GLM-5";
const DEFAULT_SYSTEM_PROMPT =
  "You are a minimal FriendliAI example agent. Be concise and helpful.";
const COMPACTION_CONTEXT_TOKENS = 600;
const COMPACTION_MAX_OUTPUT_TOKENS = 200;
const LOCAL_COMMANDS: Command[] = [
  {
    name: "new",
    aliases: ["clear", "reset"],
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

function createCompactionConfig(model: LanguageModel) {
  return {
    enabled: true,
    keepRecentTokens: COMPACTION_MAX_OUTPUT_TOKENS,
    maxTokens: COMPACTION_CONTEXT_TOKENS,
    reserveTokens: COMPACTION_MAX_OUTPUT_TOKENS,
    summarizeFn: createModelSummarizer(model),
  } as const;
}

function formatTokens(tokenCount: number): string {
  if (tokenCount >= 1000) {
    return `${(tokenCount / 1000).toFixed(1)}k`;
  }

  return String(tokenCount);
}

function formatContextUsage(
  contextUsage: NonNullable<ReturnType<MessageHistory["getContextUsage"]>>
): string {
  if (contextUsage.source === "estimated" && contextUsage.used === 0) {
    return `Context: ?/${formatTokens(contextUsage.limit)} (?)`;
  }

  return `Context: ${formatTokens(contextUsage.used)}/${formatTokens(contextUsage.limit)} (${contextUsage.percentage}%)`;
}

const main = defineCommand({
  meta: {
    name: "minimal-agent",
    description: "Minimal FriendliAI-backed agent example",
  },
  args: {
    model: {
      alias: ["m"],
      type: "string",
      description: "Override the Friendli model ID",
    },
    prompt: {
      alias: ["p"],
      type: "string",
      description:
        "User prompt. Providing this enters headless mode automatically.",
    },
  },
  async run({ args }) {
    const sessionManager = new SessionManager("minimal-agent");
    sessionManager.initialize();
    const selectedModelId = resolveModelId(args.model);
    const friendli = createFriendliProvider();
    const model = friendli(selectedModelId);
    const compaction = createCompactionConfig(model);
    const messageHistory = new MessageHistory({
      compaction,
    });
    messageHistory.setContextLimit(compaction.maxTokens);

    const agent = createAgent({
      model,
      instructions: DEFAULT_SYSTEM_PROMPT,
    });

    const prompt = args.prompt?.trim();
    if (prompt) {
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
      footer: {
        get text() {
          const contextUsage = messageHistory.getContextUsage();
          if (!contextUsage) {
            return undefined;
          }

          return formatContextUsage(contextUsage);
        },
      },
      messageHistory,
      header: {
        title: "Minimal Agent",
        get subtitle() {
          return `${selectedModelId}\nSession: ${sessionManager.getId()}`;
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
