import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { FileSnapshotStore, formatContextUsage } from "@ai-sdk-tool/harness";
import { createTogglePreferenceCommand } from "@ai-sdk-tool/harness/preferences";
import { createAgentRuntime, defineAgent } from "@ai-sdk-tool/harness/runtime";
import { runAgentSessionHeadless } from "@ai-sdk-tool/headless/session";
import { runAgentSessionTUI } from "@ai-sdk-tool/tui/session";
import { env } from "./env";
import { createPreferences, type MinimalAgentPreferences } from "./preferences";

const modelId = env.AI_MODEL;
const model = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
})(modelId);

const preferences = createPreferences();
const initialPreferences = await preferences.store.load();
let reasoningEnabled = initialPreferences?.reasoningEnabled ?? false;

const agent = defineAgent({
  name: "minimal-agent",
  agent: {
    model,
    instructions: "You are a helpful assistant. Be concise.",
    mcp: [{ command: "npx", args: ["-y", "opensearch-mcp@latest"] }],
  },
  history: {
    compaction: { enabled: true, contextLimit: env.AI_CONTEXT_LIMIT },
  },
  onBeforeTurn: () => ({
    providerOptions: reasoningEnabled
      ? { openai: { reasoningEffort: "medium" } }
      : undefined,
  }),
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
    createTogglePreferenceCommand<MinimalAgentPreferences, "reasoningEnabled">({
      name: "reasoning",
      featureName: "Reasoning",
      preferences,
      field: "reasoningEnabled",
      get: () => reasoningEnabled,
      set: (next) => {
        reasoningEnabled = next;
      },
    }),
  ],
});

const runtime = await createAgentRuntime({
  name: "minimal-agent",
  agents: [agent],
  persistence: { snapshotStore: new FileSnapshotStore(env.SESSION_DIR) },
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
          return `session: ${session.sessionId.slice(0, 8)} · reasoning: ${
            reasoningEnabled ? "on" : "off"
          }`;
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
