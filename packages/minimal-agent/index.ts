import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  FileSnapshotStore,
  formatContextUsage,
  parseCommand,
} from "@ai-sdk-tool/harness";
import { loadDotEnvFilesIfAvailable } from "@ai-sdk-tool/harness/env-node";
import { createTogglePreferenceCommand } from "@ai-sdk-tool/harness/preferences";
import { createAgentRuntime, defineAgent } from "@ai-sdk-tool/harness/runtime";
import { runAgentSessionHeadless } from "@ai-sdk-tool/headless/session";
import type { CommandPreprocessHooks } from "@ai-sdk-tool/tui";
import { runAgentSessionTUI } from "@ai-sdk-tool/tui/session";
import {
  Container,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";
import { createPreferences, type MinimalAgentPreferences } from "./preferences";

loadDotEnvFilesIfAvailable();

const { env } = await import("./env");

const modelId = env.AI_MODEL;
const model = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
})(modelId);

const preferences = createPreferences();
const initialPreferences = await preferences.store.load();
let reasoningEnabled = initialPreferences?.reasoningEnabled ?? false;

const showReasoningSelector = (
  hooks: CommandPreprocessHooks
): Promise<boolean | null> => {
  hooks.clearStatus();

  const selectorContainer = new Container();
  const currentValue = reasoningEnabled;
  const items: SelectItem[] = [
    {
      value: "on",
      label: `on${currentValue ? " (current)" : ""}`,
      description: "Enable provider-level reasoning",
    },
    {
      value: "off",
      label: `off${currentValue ? "" : " (current)"}`,
      description: "Disable provider-level reasoning",
    },
  ];

  const selectList = new SelectList(items, 10, hooks.editorTheme.selectList);
  selectList.setSelectedIndex(currentValue ? 0 : 1);

  selectorContainer.addChild(
    new Text("\x1b[2mSelect reasoning mode\x1b[0m", 1, 0)
  );
  selectorContainer.addChild(new Spacer(1));
  selectorContainer.addChild(selectList);

  hooks.overlayContainer.addChild(selectorContainer);
  hooks.tui.requestRender();

  return new Promise<boolean | null>((resolve) => {
    let settled = false;
    let removeInputListener: (() => void) | null = null;

    const finish = (value: boolean | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeInputListener?.();
      hooks.overlayContainer.removeChild(selectorContainer);
      hooks.tui.requestRender();
      resolve(value);
    };

    selectList.onSelect = (item) => {
      finish(item.value === "on");
    };
    selectList.onCancel = () => {
      finish(null);
    };

    removeInputListener = hooks.addInputListener((data: string) => {
      if (hooks.isCtrlCInput(data)) {
        finish(null);
        return { consume: true };
      }
      selectList.handleInput(data);
      hooks.tui.requestRender();
      return { consume: true };
    });
  });
};

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
  persistence: {
    snapshotStore: new FileSnapshotStore(env.MINIMAL_AGENT_DIR),
  },
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
      preprocessCommand: async (input, hooks) => {
        const parsed = parseCommand(input);
        if (!parsed || parsed.name !== "reasoning" || parsed.args.length > 0) {
          return input;
        }
        const selected = await showReasoningSelector(hooks);
        if (selected === null) {
          return null;
        }
        return `/reasoning ${selected ? "on" : "off"}`;
      },
    });
  }
} finally {
  await session.save();
  await runtime.close();
}
