import {
  type CheckpointHistoryOptions,
  CheckpointHistory,
  createAgent,
  createModelSummarizer,
  type ModelMessage,
  type RunAgentLoopResult,
  runAgentLoop,
} from "@ai-sdk-tool/harness";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env } from "./env";

const provider = createOpenAICompatible({
  name: "tgbot-provider",
  baseURL: env.AI_BASE_URL,
  apiKey: env.AI_API_KEY,
});

const model = provider.chatModel(env.AI_MODEL_ID);

const summarize = createModelSummarizer(model);

const historyOptions: CheckpointHistoryOptions = {
  compaction: {
    enabled: true,
    speculativeStartRatio: 0.8,
    summarizeFn: summarize,
  },
};

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

const chatHistories = new Map<string, CheckpointHistory>();

function getHistory(threadId: string): CheckpointHistory {
  let history = chatHistories.get(threadId);
  if (!history) {
    history = new CheckpointHistory(historyOptions);
    chatHistories.set(threadId, history);
  }
  return history;
}

export async function handleMessage(
  threadId: string,
  userText: string
): Promise<string> {
  const history = getHistory(threadId);
  history.addUserMessage(userText);

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
  const text = extractLastAssistantText(result.messages);
  console.log(
    `[tgbot] Extracted text (first 200 chars): ${text.substring(0, 200)}`
  );
  return text;
}

export function handleMessageStream(
  threadId: string,
  userText: string
): AsyncIterable<string> {
  const history = getHistory(threadId);
  history.addUserMessage(userText);

  const stream = agent.stream({
    messages: history.getMessagesForLLM(),
  });

  async function* textStream(): AsyncIterable<string> {
    for await (const part of stream.fullStream) {
      if (part.type === "text-delta") {
        yield part.text;
      }
    }

    const response = await stream.response;
    history.addModelMessages(response.messages);
  }

  return textStream();
}

export function clearHistory(threadId: string): void {
  chatHistories.delete(threadId);
}

export async function closeAgent(): Promise<void> {
  await agent.close();
}

function extractLastAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") {
      continue;
    }

    if (typeof msg.content === "string") {
      return msg.content;
    }

    if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((p) => p.type === "text")
        .map((p) => p.text);
      if (textParts.length > 0) {
        return textParts.join("");
      }
    }
  }
  return "I couldn't generate a response.";
}
