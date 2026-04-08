import { mkdirSync } from "node:fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  CheckpointHistory,
  createAgent,
  createModelSummarizer,
  getLastMessageText,
  type RunAgentLoopResult,
  runAgentLoop,
  SessionStore,
} from "@ai-sdk-tool/harness";
import { env } from "./env";

const provider = createOpenAICompatible({
  name: "tgbot-provider",
  baseURL: env.AI_BASE_URL,
  apiKey: env.AI_API_KEY,
});

const model = provider.chatModel(env.AI_MODEL_ID);

const summarize = createModelSummarizer(model);

mkdirSync(env.SESSION_DIR, { recursive: true });
const sessionStore = new SessionStore(env.SESSION_DIR);

const compactionOptions = {
  compaction: {
    enabled: true,
    speculativeStartRatio: 0.8,
    summarizeFn: summarize,
  },
} as const;

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
  }
}

function getHistory(threadId: string): Promise<CheckpointHistory> {
  let promise = chatHistories.get(threadId);
  if (promise) {
    chatHistories.delete(threadId);
    chatHistories.set(threadId, promise);
    return promise;
  }
  promise = CheckpointHistory.fromSession(
    sessionStore,
    threadId,
    compactionOptions
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
  history.addUserMessage(userText);
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
  console.log(
    `[tgbot] Extracted text (first 200 chars): ${text.substring(0, 200)}`
  );
  return text;
}

export function clearHistory(threadId: string): void {
  chatHistories.delete(threadId);
  sessionStore.deleteSession(threadId).catch((error) => {
    console.warn("[tgbot] Failed to delete session:", threadId, error);
  });
}

export async function closeAgent(): Promise<void> {
  await agent.close();
}
