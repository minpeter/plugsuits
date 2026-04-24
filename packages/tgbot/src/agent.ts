import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  createDefaultPruningConfig,
  createModelSummarizer,
  getLastMessageText,
  SessionMemoryTracker,
} from "@ai-sdk-tool/harness";
import {
  type AgentSession,
  createAgentRuntime,
  defineAgent,
} from "@ai-sdk-tool/harness/runtime";
import { FileSnapshotStore } from "@ai-sdk-tool/harness/sessions";
import { buildCompactionTokenBudget } from "./compaction-config";
import { env } from "./env";

const provider = createOpenAICompatible({
  name: "tgbot-provider",
  baseURL: env.AI_BASE_URL,
  apiKey: env.AI_API_KEY,
});
const model = provider.chatModel(env.AI_MODEL);
const snapshotStore = new FileSnapshotStore(env.TGBOT_DIR);
const summarize = createModelSummarizer(model);
const threadTrackers = new Map<string, SessionMemoryTracker>();
const threadSaveChains = new Map<string, Promise<void>>();
const sessions = new Map<string, AgentSession>();
const MAX_CACHED_THREADS = 100;
const instructions = `You are a helpful Telegram assistant named Apex. Be concise and direct.

FORMATTING RULES (Telegram Markdown — follow EXACTLY):
- Bold: *bold text* (single asterisk on each side, NOT double **)
- Italic: _italic text_ (single underscore on each side)
- Code: \`inline code\` (backticks)
- Code block: \`\`\`code block\`\`\` (triple backticks, no language specifier)
- NEVER use [text](url) link syntax — just paste the raw URL
- NEVER use bullet points with * or - at the start of a line
- For lists, use numbered lists (1. 2. 3.) or just line breaks
- NEVER use headers (#, ##, etc.)
- NEVER use **double asterisks** for bold — Telegram does not support this

You have web search tools (web_search_exa, web_fetch_exa).
Use them when the user asks about current events, facts, or anything that needs up-to-date information.
If you don't know something, search the web first before saying you don't know.`;

function getTracker(threadId: string): SessionMemoryTracker {
  let tracker = threadTrackers.get(threadId);
  if (!tracker) {
    tracker = new SessionMemoryTracker();
    threadTrackers.set(threadId, tracker);
  }
  return tracker;
}

function historyConfig(threadId: string) {
  const tracker = getTracker(threadId);
  const compactionBudget = buildCompactionTokenBudget(env.AI_CONTEXT_LIMIT);

  return {
    compaction: {
      enabled: true,
      contextLimit: env.AI_CONTEXT_LIMIT,
      ...compactionBudget,
      getStructuredState: tracker.getStructuredState.bind(tracker),
      summarizeFn: summarize,
    },
    pruning: createDefaultPruningConfig(),
  } as const;
}

const runtime = await createAgentRuntime({
  name: "tgbot",
  agents: [
    defineAgent({
      name: "tgbot",
      agent: { model, mcp: [{ url: "https://mcp.exa.ai/mcp" }], instructions },
      history: historyConfig("runtime-init"),
      onTurnComplete: ({ messages }, ctx) => {
        const text = getLastMessageText(messages, "assistant", { joiner: "" });
        if (text) {
          getTracker(ctx.sessionId).extractFactsFromSummary(text);
        }
      },
    }),
  ] as const,
  persistence: { snapshotStore, autoSave: false },
  session: { prefix: "tgbot" },
});

function queue(
  threadId: string,
  operation: () => Promise<void>
): Promise<void> {
  const next = (threadSaveChains.get(threadId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(operation);
  threadSaveChains.set(threadId, next);
  next.catch((error) =>
    console.warn("[tgbot] Thread persistence failed:", threadId, error)
  );
  next
    .finally(() => {
      if (threadSaveChains.get(threadId) === next) {
        threadSaveChains.delete(threadId);
      }
    })
    .catch(() => undefined);
  return next;
}

function touchSession(threadId: string, session: AgentSession): AgentSession {
  sessions.delete(threadId);
  sessions.set(threadId, session);
  if (sessions.size > MAX_CACHED_THREADS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) {
      sessions.delete(oldest);
      threadTrackers.delete(oldest);
    }
  }
  return session;
}

async function getSession(threadId: string): Promise<AgentSession> {
  const existing = sessions.get(threadId);
  if (existing) {
    return touchSession(threadId, existing);
  }
  const session = await runtime.resumeSession({ sessionId: threadId });
  await session.reconfigure({ history: historyConfig(threadId) });
  return touchSession(threadId, session);
}

export async function recordMessage(
  threadId: string,
  userText: string
): Promise<void> {
  const session = await getSession(threadId);
  getTracker(threadId).extractFactsFromUserMessage(userText);
  session.addUserMessage(userText);
  await queue(threadId, () => session.save());
}

export async function handleMessage(threadId: string): Promise<string> {
  const session = await getSession(threadId);
  const result = await session.runTurn({
    maxIterations: env.MAX_ITERATIONS,
    onStepComplete: async () => await queue(threadId, () => session.save()),
  });
  await queue(threadId, () => session.save());
  return (
    getLastMessageText(result.messages, "assistant", { joiner: "" }) ||
    "I couldn't generate a response."
  );
}

export function clearHistory(threadId: string): void {
  sessions.delete(threadId);
  threadTrackers.delete(threadId);
  queue(threadId, async () => await snapshotStore.delete(threadId)).catch(
    () => undefined
  );
}

export async function closeAgent(): Promise<void> {
  await runtime.close();
}
