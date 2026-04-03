import {
  CheckpointHistory,
  type Command,
  CompactionCircuitBreaker,
  type CompactionResult,
  type ContextUsage,
  createAgent,
  createModelSummarizer,
  estimateTokens,
  SessionManager,
  SessionMemoryTracker,
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
const DEFAULT_SYSTEM_PROMPT = `You are a minimal example agent. Be concise and helpful.
When the user shares personal information (name, preferences, pets, job, hobbies, etc.), remember it carefully.
When asked to recall information, list ALL known facts — do not omit any details.`;

const CHATBOT_COMPACTION_PROMPT = `[INTERNAL COMPACTION — NOT USER INPUT]
This is a summarization task. Do NOT call any tools. Respond with text only.
Recent messages are preserved separately — focus your summary on OLDER messages only.

First, wrap your analysis in <analysis> tags to organize your thoughts:
1. Chronologically review each user message and identify every personal fact shared
2. Check if there is a <previous-summary> — if so, extract ALL user facts from it
3. Merge old facts with new facts, ensuring nothing is lost
4. Verify completeness: have you captured every name, place, preference, pet, person, date, and detail?

Then provide your summary in <summary> tags with these sections:

## 1. User Profile
Extract ALL personal details from the ENTIRE conversation history AND any <previous-summary>.
Use bullet points. Include: name, job, location, pets (name, breed, age, tricks), family (names, relationships), hobbies, preferences, favorites (food, book, color, movie, music), routines, goals, and any other facts.
CRITICAL: If a <previous-summary> contains user facts, you MUST carry them forward even if they were not mentioned in recent messages. Never drop facts.

## 2. All User Messages
List every user message (not tool results) as a brief summary. This preserves the user's intent and feedback trail.

## 3. Key Conversations
Summarize important topics: questions asked, advice given, decisions made. Be brief but specific.

## 4. Current State
What was being discussed most recently? What would the user likely ask about next?

Output format: <analysis>your thinking</analysis><summary>your summary</summary>`;

// --- Compaction tuning for 30-turn chatbot within 4096 tokens ---
// Context budget: 4096 tokens total
// Reserve 512 tokens for model output (~12.5% of context)
// Keep 800 tokens of recent messages (~8-10 turns) during compaction
// Trigger blocking compaction at 65% of context (2662 tokens, ~turn 26-28)
// Start speculative compaction at 80% of blocking threshold (2130 tokens, ~turn 22-24)
// Goal: minimize compaction cycles to maximize memory retention
const COMPACTION_CONTEXT_TOKENS = 4096;
const COMPACTION_RESERVE_TOKENS = 512;
const COMPACTION_KEEP_RECENT_TOKENS = 800;
const COMPACTION_THRESHOLD_RATIO = 0.65;
const COMPACTION_SPECULATIVE_RATIO = 0.8;
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

function createCompactionConfig(
  model: LanguageModel,
  tracker: SessionMemoryTracker
) {
  return {
    enabled: true,
    contextLimit: COMPACTION_CONTEXT_TOKENS,
    keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
    microCompact: true,
    reserveTokens: COMPACTION_RESERVE_TOKENS,
    thresholdRatio: COMPACTION_THRESHOLD_RATIO,
    speculativeStartRatio: COMPACTION_SPECULATIVE_RATIO,
    getStructuredState: tracker.getStructuredState.bind(tracker),
    summarizeFn: createModelSummarizer(model, {
      contextLimit: COMPACTION_CONTEXT_TOKENS,
      prompt: CHATBOT_COMPACTION_PROMPT,
    }),
  } as const;
}

function formatTokens(tokenCount: number): string {
  if (tokenCount >= 1000) {
    return `${(tokenCount / 1000).toFixed(1)}k`;
  }

  return String(tokenCount);
}

function formatContextUsage(contextUsage: ContextUsage): string {
  if (contextUsage.limit <= 0) {
    return `?/${formatTokens(contextUsage.limit)} (?)`;
  }

  return `${formatTokens(contextUsage.used)}/${formatTokens(contextUsage.limit)} (${contextUsage.percentage}%)`;
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
    const circuitBreaker = new CompactionCircuitBreaker();
    const sessionMemoryTracker = new SessionMemoryTracker();
    const selectedModelId = resolveModelId(args.model);
    const friendli = createFriendliProvider();
    const model = friendli(selectedModelId);
    const compaction = createCompactionConfig(model, sessionMemoryTracker);
    const messageHistory = new CheckpointHistory({
      compaction,
    });
    messageHistory.setContextLimit(COMPACTION_CONTEXT_TOKENS);
    messageHistory.setSystemPromptTokens(estimateTokens(DEFAULT_SYSTEM_PROMPT));

    const agent = createAgent({
      model,
      instructions: DEFAULT_SYSTEM_PROMPT,
    });

    const handleTurnComplete = (
      messages: Array<{ message: { role: string; content: unknown } }>
    ): void => {
      for (const { message } of messages) {
        if (message.role === "user" && typeof message.content === "string") {
          sessionMemoryTracker.extractFactsFromUserMessage(message.content);
        }
      }
    };

    const handleCompactionComplete = (result: CompactionResult): void => {
      if (!(result.success && result.summaryMessageId)) {
        return;
      }
      const msg = messageHistory
        .getAll()
        .find((m) => m.id === result.summaryMessageId);
      if (
        msg?.message.role === "assistant" &&
        typeof msg.message.content === "string"
      ) {
        sessionMemoryTracker.extractFactsFromSummary(msg.message.content);
      }
    };

    const prompt = args.prompt?.trim();
    if (prompt) {
      await runHeadless({
        agent,
        circuitBreaker,
        sessionId: sessionManager.getId(),
        emitEvent,
        initialUserMessage: {
          content: prompt,
        },
        messageHistory,
        maxIterations: 1,
        modelId: selectedModelId,
        compactionCallbacks: {
          onCompactionComplete: handleCompactionComplete,
        },
        onTurnComplete: handleTurnComplete,
      });
      return;
    }

    await createAgentTUI({
      agent,
      circuitBreaker,
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
      compactionCallbacks: {
        onCompactionComplete: handleCompactionComplete,
      },
      onTurnComplete: handleTurnComplete,
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
