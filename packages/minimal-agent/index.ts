import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelMessage } from "ai";
import {
  CompactionCircuitBreaker,
  createDefaultPruningConfig,
  createModelSummarizer,
  FileSnapshotStore,
  formatContextUsage,
  getLastMessageText,
  SessionMemoryTracker,
  type Command,
  type CompactionResult,
} from "@ai-sdk-tool/harness";
import { createAgentRuntime, defineAgent } from "@ai-sdk-tool/harness/runtime";
import { runAgentSessionHeadless } from "@ai-sdk-tool/headless/session";
import { runAgentSessionTUI } from "@ai-sdk-tool/tui/session";
import { defineCommand, runMain } from "citty";
import {
  COMPACTION_CONTEXT_TOKENS,
  COMPACTION_KEEP_RECENT_TOKENS,
  COMPACTION_RESERVE_TOKENS,
  COMPACTION_SPECULATIVE_RATIO,
  COMPACTION_THRESHOLD_RATIO,
} from "./compaction-config";
import { env } from "./env";

const SYSTEM_PROMPT =
  "You are a minimal example agent. Be concise and helpful.\nWhen the user shares personal information (name, preferences, pets, job, hobbies, etc.), remember it carefully.\nWhen asked to recall information, list ALL known facts — do not omit any details.";
const CHATBOT_COMPACTION_PROMPT =
  "[INTERNAL COMPACTION — NOT USER INPUT]\nThis is a summarization task. Do NOT call any tools. Respond with text only.\nRecent messages are preserved separately — focus your summary on OLDER messages only.\n\nFirst, wrap your analysis in <analysis> tags to organize your thoughts:\n1. Chronologically review each user message and identify every personal fact shared\n2. Check if there is a <previous-summary> — if so, extract ALL user facts from it\n3. Merge old facts with new facts, ensuring nothing is lost\n4. Verify completeness: have you captured every name, place, preference, pet, person, date, and detail?\n\nThen provide your summary in <summary> tags with these sections:\n## 1. User Profile\nExtract ALL personal details from the ENTIRE conversation history AND any <previous-summary>.\nUse bullet points. Include: name, job, location, pets (name, breed, age, tricks), family (names, relationships), hobbies, preferences, favorites (food, book, color, movie, music), routines, goals, and any other facts.\nCRITICAL: If a <previous-summary> contains user facts, you MUST carry them forward even if they were not mentioned in recent messages. Never drop facts.\n## 2. All User Messages\nList every user message (not tool results) as a brief summary. This preserves the user's intent and feedback trail.\n## 3. Key Conversations\nSummarize important topics: questions asked, advice given, decisions made. Be brief but specific.\n## 4. Current State\nWhat was being discussed most recently? What would the user likely ask about next?\n\nOutput format: <analysis>your thinking</analysis><summary>your summary</summary>";
const anthropic = createAnthropic({
  apiKey: env.ANTHROPIC_API_KEY ?? "",
  ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
});
const modelId = env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const memory = new SessionMemoryTracker();
const summarize = createModelSummarizer(anthropic(modelId), {
  contextLimit: COMPACTION_CONTEXT_TOKENS,
  prompt: CHATBOT_COMPACTION_PROMPT,
});
const commands: Command[] = [
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
const history = {
  pruning: createDefaultPruningConfig(),
  compaction: {
    compactionDirection: "keep-recent" as const,
    enabled: true,
    contextLimit: COMPACTION_CONTEXT_TOKENS,
    keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
    microCompact: true,
    reserveTokens: COMPACTION_RESERVE_TOKENS,
    thresholdRatio: COMPACTION_THRESHOLD_RATIO,
    speculativeStartRatio: COMPACTION_SPECULATIVE_RATIO,
    getStructuredState: () => memory.getStructuredState(),
    summarizeFn: summarize,
  },
};
let lastProcessedMessageCount = 0;

function extractFacts(
  messages: Array<ModelMessage | { message: ModelMessage }>
): void {
  const normalized = messages.map((message) =>
    "message" in message ? message.message : message
  );
  for (const message of normalized.slice(
    Math.min(lastProcessedMessageCount, normalized.length)
  )) {
    if (message.role !== "user") {
      continue;
    }
    const text = getLastMessageText([message], "user", { trim: true });
    if (text) {
      memory.extractFactsFromUserMessage(text);
    }
  }
  lastProcessedMessageCount = normalized.length;
}

function onCompactionComplete(
  { success, summaryMessageId }: CompactionResult,
  getSummary: () => ModelMessage | undefined
): void {
  if (!success) {
    return;
  }
  if (!summaryMessageId) {
    return;
  }
  const summary = getSummary();
  if (summary?.role === "assistant") {
    memory.extractFactsFromSummary(
      getLastMessageText([summary], "assistant", { trim: true })
    );
  }
}

const chatbot = defineAgent({
  name: "minimal-agent",
  agent: async () => ({
    model: anthropic(modelId),
    instructions: async () =>
      [SYSTEM_PROMPT, memory.getStructuredState()].filter(Boolean).join("\n\n"),
    mcp: [{ command: "npx", args: ["-y", "duckduckgo-mcp@latest"] }],
  }),
  history,
  commands,
  onTurnComplete: ({ messages }) => {
    extractFacts(messages as Array<ModelMessage | { message: ModelMessage }>);
  },
});
const circuitBreaker = new CompactionCircuitBreaker();
const runtime = await createAgentRuntime({
  name: "minimal-agent",
  agents: [chatbot] as const,
  persistence: { snapshotStore: new FileSnapshotStore(".plugsuits/sessions") },
});
const session = await runtime.openSession();
const getSummary = (id: string) =>
  session.history.getAll().find((message) => message.id === id)?.message;

const main = defineCommand({
  args: {
    prompt: { type: "string", description: "Run a single headless prompt" },
  },
  async run({ args }) {
    try {
      if (args.prompt) {
        await runAgentSessionHeadless(session, {
          initialUserMessage: { content: args.prompt },
          modelId,
          circuitBreaker,
          compactionCallbacks: {
            onCompactionComplete: (result) =>
              onCompactionComplete(result, () =>
                result.summaryMessageId
                  ? getSummary(result.summaryMessageId)
                  : undefined
              ),
          },
          maxIterations: 1,
        });
      } else {
        await runAgentSessionTUI(session, {
          header: {
            title: "minimal-agent",
            get subtitle() {
              return `session: ${session.sessionId.slice(0, 8)}`;
            },
          },
          footer: {
            get text() {
              const usage = session.history.getContextUsage();
              return usage
                ? formatContextUsage(usage, {
                    reserveTokens: COMPACTION_RESERVE_TOKENS,
                    thresholdRatio: COMPACTION_THRESHOLD_RATIO,
                  })
                : undefined;
            },
          },
          circuitBreaker,
          compactionCallbacks: {
            onCompactionComplete: (result) =>
              onCompactionComplete(result, () =>
                result.summaryMessageId
                  ? getSummary(result.summaryMessageId)
                  : undefined
              ),
          },
          onCommandAction: async (action) => {
            if (action.type === "new-session") {
              await session.reset();
              circuitBreaker.resetForNewSession();
              memory.clear();
              lastProcessedMessageCount = 0;
            }
          },
        });
      }
    } finally {
      await session.save();
      await runtime.close();
    }
  },
});

runMain(main);
