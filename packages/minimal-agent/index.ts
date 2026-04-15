import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { FileSnapshotStore, formatContextUsage } from "@ai-sdk-tool/harness";
import { createAgentRuntime, defineAgent } from "@ai-sdk-tool/harness/runtime";
import { runAgentSessionHeadless } from "@ai-sdk-tool/headless/session";
import { runAgentSessionTUI } from "@ai-sdk-tool/tui/session";
import { env } from "./env";

const modelId = env.AI_MODEL;
const model = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
})(modelId);

const agent = defineAgent({
  name: "minimal-agent",
  agent: {
    model,
    instructions: "You are a helpful assistant. Be concise.",
    mcp: [{ command: "bunx", args: ["duckduckgo-mcp@latest"] }],
  },
  history: {
    compaction: { enabled: true, contextLimit: env.AI_CONTEXT_LIMIT },
  },
  commands: [
    {
      name: "new",
      aliases: ["clear", "reset"],
      description: "Start a new session",
      execute: () => ({
        success: true,
        action: { type: "new-session" },
        message: "New session.",
      }),
    },
  ],
});

const runtime = await createAgentRuntime({
  name: "minimal-agent",
  agents: [agent],
  persistence: { snapshotStore: new FileSnapshotStore(".plugsuits/sessions") },
});
const session = await runtime.openSession();

const prompt = process.argv.find((_, i, arr) => arr[i - 1] === "--prompt");

try {
  if (prompt) {
    await runAgentSessionHeadless(session, {
      initialUserMessage: { content: prompt },
      modelId,
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
          const u = session.history.getContextUsage();
          return u ? formatContextUsage(u) : undefined;
        },
      },
      onCommandAction: async (action) => {
        if (action.type === "new-session") {
          await session.reset();
        }
      },
    });
  }
} finally {
  await session.save();
  await runtime.close();
}
