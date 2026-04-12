import { mkdirSync } from "node:fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  CheckpointHistory,
  createAgent,
  createDefaultPruningConfig,
  createModelSummarizer,
  FileSnapshotStore,
  getLastMessageText,
  type RunAgentLoopResult,
  runAgentLoop,
  SessionMemoryTracker,
} from "@ai-sdk-tool/harness";
import { env } from "./env";

const provider = createOpenAICompatible({
  name: "tgbot-provider",
  baseURL: env.AI_BASE_URL,
  apiKey: env.AI_API_KEY,
});

const model = provider.chatModel(env.AI_MODEL_ID);

const summarize = createModelSummarizer(model);
const threadTrackers = new Map<string, SessionMemoryTracker>();

function getTracker(threadId: string): SessionMemoryTracker {
  let t = threadTrackers.get(threadId);
  if (!t) {
    t = new SessionMemoryTracker();
    threadTrackers.set(threadId, t);
  }
  return t;
}

mkdirSync(env.SESSION_DIR, { recursive: true });
const snapshotStore = new FileSnapshotStore(env.SESSION_DIR);

function buildCompactionOptions(threadId: string) {
  const t = getTracker(threadId);
  return {
    compaction: {
      enabled: true,
      contextLimit: 100_000,
      keepRecentTokens: 30_000,
      reserveTokens: 20_000,
      maxTokens: 50_000,
      thresholdRatio: 0.65,
      speculativeStartRatio: 0.8,
      getStructuredState: t.getStructuredState.bind(t),
      summarizeFn: summarize,
    },
    pruning: createDefaultPruningConfig(),
  } as const;
}

const agent = await createAgent({
  model,
  mcp: [{ url: "https://mcp.exa.ai/mcp" }],
  instructions: [
    "You are a helpful Telegram assistant named Apex. Be concise and direct.",
    "",
    "FORMATTING RULES (Telegram Markdown — follow EXACTLY):",
    "- Bold: *bold text* (single asterisk on each side, NOT double **)",
    "- Italic: _italic text_ (single underscore on each side)",
    "- Code: `inline code` (backticks)",
    "- Code block: ```code block``` (triple backticks, no language specifier)",
    "- NEVER use [text](url) link syntax — just paste the raw URL",
    "- NEVER use bullet points with * or - at the start of a line",
    "- For lists, use numbered lists (1. 2. 3.) or just line breaks",
    "- NEVER use headers (#, ##, etc.)",
    "- NEVER use **double asterisks** for bold — Telegram does not support this",
    "",
    "You have web search tools (web_search_exa, web_fetch_exa).",
    "Use them when the user asks about current events, facts, or anything that needs up-to-date information.",
    "If you don't know something, search the web first before saying you don't know.",
  ].join("\n"),
});

const MAX_CACHED_THREADS = 100;
const chatHistories = new Map<string, Promise<CheckpointHistory>>();

function evictOldest(): void {
  if (chatHistories.size <= MAX_CACHED_THREADS) {
    return;
  }
  const oldest = chatHistories.keys().next().value;
  if (oldest !== undefined) {
    chatHistories.delete(oldest);
    threadTrackers.delete(oldest);
    snapshotStore.delete(oldest).catch((error) => {
      console.warn("[tgbot] Failed to delete snapshot:", oldest, error);
    });
  }
}

function getHistory(threadId: string): Promise<CheckpointHistory> {
  let promise = chatHistories.get(threadId);
  if (promise) {
    chatHistories.delete(threadId);
    chatHistories.set(threadId, promise);
    return promise;
  }
  promise = CheckpointHistory.fromSnapshot(
    snapshotStore,
    threadId,
    buildCompactionOptions(threadId)
  );
  promise.catch(() => {
    if (chatHistories.get(threadId) === promise) {
      chatHistories.delete(threadId);
    }
  });
  chatHistories.set(threadId, promise);
  evictOldest();
  return promise;
}

export async function recordMessage(
  threadId: string,
  userText: string
): Promise<void> {
  const history = await getHistory(threadId);
  getTracker(threadId).extractFactsFromUserMessage(userText);
  history.addUserMessage(userText);
  await snapshotStore.save(threadId, history.snapshot());
}

export async function handleMessage(threadId: string): Promise<string> {
  const history = await getHistory(threadId);

  const result: RunAgentLoopResult = await runAgentLoop({
    agent,
    messages: history.getMessagesForLLM(),
    maxIterations: env.MAX_ITERATIONS,
    onToolCall: (call) => {
      console.log(
        `[tgbot] Tool called: ${call.toolName}`,
        JSON.stringify(call).substring(0, 300)
      );
    },
    onStepComplete: (step) => {
      console.log(
        `[tgbot] Step complete: iteration=${step.iteration}, finishReason=${step.finishReason}, messages=${step.response.messages.length}`
      );
      history.addModelMessages(step.response.messages);
      snapshotStore.save(threadId, history.snapshot()).catch((error) => {
        console.warn("[tgbot] Failed to save snapshot:", threadId, error);
      });
    },
    onError: (error) => {
      console.error("[tgbot] Loop error:", error);
    },
  });

  console.log(
    `[tgbot] Loop done: iterations=${result.iterations}, finishReason=${result.finishReason}, totalMessages=${result.messages.length}`
  );
  const text =
    getLastMessageText(result.messages, "assistant", { joiner: "" }) ||
    "I couldn't generate a response.";
  return text;
}

export function clearHistory(threadId: string): void {
  chatHistories.delete(threadId);
  threadTrackers.delete(threadId);
  snapshotStore.delete(threadId).catch((error) => {
    console.warn("[tgbot] Failed to delete snapshot:", threadId, error);
  });
}

export async function closeAgent(): Promise<void> {
  await agent.close();
}
