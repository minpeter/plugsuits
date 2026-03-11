#!/usr/bin/env bun

import {
  type Command,
  type CommandContext,
  estimateTokens,
  MessageHistory,
  parseCommand,
  type RunnableAgent,
  SessionManager,
  shouldContinueManualToolLoop,
} from "@ai-sdk-tool/harness";
import { emitEvent, runHeadless } from "@ai-sdk-tool/headless";
import {
  type CommandPreprocessHooks,
  createAgentTUI,
  type PreprocessHooks,
  type PreprocessResult,
} from "@ai-sdk-tool/tui";
import type { EditorTheme, MarkdownTheme } from "@mariozechner/pi-tui";
import {
  Container,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";
import type { FinishReason } from "ai";
import { defineCommand, runMain } from "citty";
import { agentManager } from "../agent";
import {
  normalizeRawArgs,
  resolveSharedConfig,
  type SharedArgs,
  sharedArgsDef,
} from "../cli-defs";
import { getCommands, registerCommand } from "../commands";
import { createClearCommand } from "../commands/clear";
import { createCompactCommand } from "../commands/compact";
import {
  applyModelSelection,
  createModelCommand,
  findModelBySelection,
  getAvailableModels,
  type ModelInfo,
} from "../commands/model";
import { createReasoningModeCommand } from "../commands/reasoning-mode";
import { createRenderCommand } from "../commands/render";
import { createToolFallbackCommand } from "../commands/tool-fallback";
import { createTranslateCommand } from "../commands/translate";
import type { SkillInfo } from "../context/skills";
import { loadAllSkills } from "../context/skills";
import { isNonEnglish, translateToEnglish } from "../context/translation";
import { env, validateProviderConfig } from "../env";
import { setSpinnerOutputEnabled } from "../interaction/spinner";
import { createToolRenderers } from "../interaction/tool-renderers";
import {
  buildTodoContinuationUserMessage,
  getIncompleteTodos,
} from "../middleware/todo-continuation";
import {
  DEFAULT_REASONING_MODE,
  parseReasoningMode,
  REASONING_MODES,
  type ReasoningMode,
} from "../reasoning-mode";
import {
  parseToolFallbackMode,
  TOOL_FALLBACK_MODES,
  type ToolFallbackMode,
} from "../tool-fallback-mode";
import { resetMissingLinesFailures } from "../tools/modify/edit-file-diagnostics";
import { cleanup } from "../tools/utils/execute/process-manager";
import { initializeTools } from "../utils/tools-manager";

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_ITALIC = "\x1b[3m";
const ANSI_UNDERLINE = "\x1b[4m";
const ANSI_GREEN = "\x1b[92m";
const ANSI_YELLOW = "\x1b[93m";
const ANSI_MAGENTA = "\x1b[95m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_BRIGHT_CYAN = "\x1b[96m";
const ANSI_GRAY = "\x1b[90m";

const style = (prefix: string, text: string): string => {
  return `${prefix}${text}${ANSI_RESET}`;
};

const formatTokens = (n: number): string => {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
};

const formatContextUsage = (
  contextUsage: NonNullable<
    MessageHistory["getContextUsage"] extends () => infer T ? T : never
  >
): string => {
  if (contextUsage.source === "estimated" && contextUsage.used === 0) {
    return `?/${formatTokens(contextUsage.limit)} (?)`;
  }

  return `${formatTokens(contextUsage.used)}/${formatTokens(contextUsage.limit)} (${contextUsage.percentage}%)`;
};

const buildCurrentIndicatorLabel = (
  label: string,
  isCurrent: boolean
): string => {
  return isCurrent ? `${label} (current)` : label;
};

const buildModelSelectorLabel = (
  model: ModelInfo,
  isCurrent: boolean
): string => {
  return buildCurrentIndicatorLabel(model.id, isCurrent);
};

const buildModelSelectorDescription = (model: ModelInfo): string => {
  let providerLabel = "FriendliAI";
  if (model.provider === "anthropic") {
    providerLabel = "Anthropic";
  } else if (model.type === "dedicated") {
    providerLabel = "FDE";
  }

  if (model.name?.trim()) {
    return `${model.name} • ${providerLabel}`;
  }

  return providerLabel;
};

const createMarkdownTheme = (): MarkdownTheme => {
  return {
    heading: (text) => style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, text),
    link: (text) => style(`${ANSI_UNDERLINE}${ANSI_CYAN}`, text),
    linkUrl: (text) => style(ANSI_GRAY, text),
    code: (text) => style(ANSI_YELLOW, text),
    codeBlock: (text) => style(ANSI_GREEN, text),
    codeBlockBorder: (text) => style(ANSI_GRAY, text),
    quote: (text) => style(`${ANSI_ITALIC}${ANSI_GRAY}`, text),
    quoteBorder: (text) => style(ANSI_GRAY, text),
    hr: (text) => style(ANSI_GRAY, text),
    listBullet: (text) => style(ANSI_MAGENTA, text),
    bold: (text) => style(ANSI_BOLD, text),
    italic: (text) => style(ANSI_ITALIC, text),
    strikethrough: (text) => style(ANSI_DIM, text),
    underline: (text) => style(ANSI_UNDERLINE, text),
    codeBlockIndent: "  ",
  };
};

const createEditorTheme = (): EditorTheme => {
  return {
    borderColor: (text: string) => style(ANSI_GRAY, text),
    selectList: {
      selectedPrefix: (text: string) => style(`${ANSI_BOLD}${ANSI_CYAN}`, text),
      selectedText: (text: string) => style(ANSI_CYAN, text),
      description: (text: string) => style(ANSI_GRAY, text),
      scrollInfo: (text: string) => style(ANSI_DIM, text),
      noMatch: (text: string) => style(ANSI_DIM, text),
    },
  };
};

const messageHistory = new MessageHistory();
const sessionManagerScope = globalThis as typeof globalThis & {
  __ceaSessionManager?: SessionManager;
};
if (!sessionManagerScope.__ceaSessionManager) {
  sessionManagerScope.__ceaSessionManager = new SessionManager();
}
const sessionManager = sessionManagerScope.__ceaSessionManager;

let requestedProcessExitCode: number | null = null;
let signalShutdownRequested = false;

registerCommand(
  createRenderCommand(async () => ({
    model: agentManager.getModelId(),
    modelType: agentManager.getModelType(),
    instructions: await agentManager.getInstructions(),
    tools: agentManager.getTools(),
    messages: messageHistory.toModelMessages(),
    reasoningMode: agentManager.getReasoningMode(),
    toolFallbackMode: agentManager.getToolFallbackMode(),
  }))
);
registerCommand(createModelCommand());
registerCommand(createClearCommand());
registerCommand(createReasoningModeCommand());
registerCommand(createToolFallbackCommand());
registerCommand(createTranslateCommand());
registerCommand(createCompactCommand(() => messageHistory));

const createTranslationPreprocessor = () => {
  return async (
    input: string,
    hooks: PreprocessHooks
  ): Promise<PreprocessResult | undefined> => {
    if (!(agentManager.isTranslationEnabled() && isNonEnglish(input))) {
      return undefined;
    }

    hooks.showStatus("Translating...");

    try {
      const result = await translateToEnglish(input, agentManager);

      if (result.error) {
        return {
          contentForModel: input,
          error: `[translation] Failed to translate input: ${result.error}. Using original text.`,
        };
      }

      if (!result.translated || result.text === input) {
        return undefined;
      }

      return {
        contentForModel: result.text,
        originalContent: input,
        translatedDisplay: result.text,
      };
    } finally {
      hooks.clearStatus();
    }
  };
};

const buildAgentStreamWithTodoContinuation = (): RunnableAgent => {
  return {
    stream: async (opts) => {
      const stream = await agentManager.stream(opts.messages, {
        abortSignal: opts.abortSignal,
        maxOutputTokens: opts.maxOutputTokens,
      });

      const continuationDecision = (async (): Promise<{
        finishReason: FinishReason;
        reminder: string | null;
      }> => {
        const baseFinishReason = await stream.finishReason;
        if (shouldContinueManualToolLoop(baseFinishReason)) {
          return {
            finishReason: baseFinishReason,
            reminder: null,
          };
        }

        const incompleteTodos = await getIncompleteTodos();
        if (incompleteTodos.length === 0) {
          return {
            finishReason: baseFinishReason,
            reminder: null,
          };
        }

        return {
          finishReason: "tool-calls",
          reminder: buildTodoContinuationUserMessage(incompleteTodos),
        };
      })();

      const response = (async () => {
        const baseResponse = await stream.response;
        const decision = await continuationDecision;
        if (!decision.reminder) {
          return baseResponse;
        }

        type StreamResponse = Awaited<typeof stream.response>;
        const reminderMessage = {
          role: "user",
          content: decision.reminder,
        } as unknown as StreamResponse["messages"][number];

        return {
          ...baseResponse,
          messages: [...baseResponse.messages, reminderMessage],
        } as StreamResponse;
      })();

      return {
        ...stream,
        response,
        finishReason: continuationDecision.then(
          (decision) => decision.finishReason
        ),
      };
    },
  };
};

const updateCompactionForCurrentModel = async (): Promise<void> => {
  messageHistory.updateCompaction(agentManager.buildCompactionConfig());
  messageHistory.setContextLimit(
    agentManager.getModelTokenLimits().contextLength
  );
  const instructions = await agentManager.getInstructions();
  messageHistory.setSystemPromptTokens(estimateTokens(instructions));
};

const wrapCommand = (
  command: Command,
  execute: (
    context: CommandContext,
    original: Command["execute"]
  ) => ReturnType<Command["execute"]>
): Command => {
  return {
    ...command,
    execute: (context) => execute(context, command.execute),
  };
};

const createCliCommands = (): Command[] => {
  const commands = Array.from(getCommands().values());

  return commands.map((command) => {
    if (command.name === "model") {
      return wrapCommand(command, async (context, original) => {
        const result = await original(context);
        if (result.success) {
          await updateCompactionForCurrentModel();
        }
        return result;
      });
    }

    if (command.name === "reasoning-mode" || command.name === "think") {
      return wrapCommand(command, async (context, original) => {
        const result = await original(context);
        if (result.success) {
          await updateCompactionForCurrentModel();
        }
        return result;
      });
    }

    return command;
  });
};

const exitWithCleanup = (code: number): never => {
  cleanup(true);
  process.exit(code);
};

const requestSignalShutdown = (code: number): void => {
  if (signalShutdownRequested) {
    return;
  }
  signalShutdownRequested = true;
  requestedProcessExitCode = code;
  exitWithCleanup(code);
};

process.once("exit", () => {
  cleanup();
});

process.once("SIGTERM", () => {
  requestSignalShutdown(143);
});

process.once("SIGHUP", () => {
  requestSignalShutdown(129);
});

process.once("SIGQUIT", () => {
  requestSignalShutdown(131);
});

process.once("uncaughtException", (error: unknown) => {
  console.error("Fatal error:", error);
  exitWithCleanup(1);
});

process.once("unhandledRejection", (reason: unknown) => {
  console.error("Unhandled rejection:", reason);
  exitWithCleanup(1);
});

const mainCommand = defineCommand({
  meta: {
    name: "plugsuits",
    version: "2.0.0",
    description: "Code Editing Agent",
  },
  args: {
    ...sharedArgsDef,
    prompt: {
      type: "string",
      alias: "p",
      description:
        "User prompt. Providing this enters headless mode automatically.",
    },
    "max-iterations": {
      type: "string",
      description: "Maximum number of iterations (headless mode only)",
    },
  },
  async run({ args }) {
    validateProviderConfig();
    await initializeTools();
    setSpinnerOutputEnabled(false);
    sessionManager.initialize();

    const config = resolveSharedConfig(args as SharedArgs);
    if (config.provider) {
      agentManager.setProvider(config.provider);
    }
    if (config.model) {
      agentManager.setModelId(config.model);
    }
    if (config.reasoningMode !== null) {
      agentManager.setReasoningMode(config.reasoningMode);
    }
    agentManager.setToolFallbackMode(config.toolFallbackMode);
    agentManager.setTranslationEnabled(config.translateUserPrompts);
    await updateCompactionForCurrentModel();

    const promptArg = (
      args as SharedArgs & { prompt?: string; "max-iterations"?: string }
    ).prompt?.trim();
    if (promptArg) {
      agentManager.setHeadlessMode(true);
      const headlessStartedAt = Date.now();

      const preparedPrompt = agentManager.isTranslationEnabled()
        ? await translateToEnglish(promptArg, agentManager)
        : { translated: false, text: promptArg };

      if (preparedPrompt.error) {
        emitEvent({
          timestamp: new Date().toISOString(),
          type: "error",
          sessionId: sessionManager.getId(),
          error: `[translation] Failed to translate input: ${preparedPrompt.error}. Using original text.`,
        });
      }

      const maxIterationsRaw = (
        args as SharedArgs & { "max-iterations"?: string }
      )["max-iterations"]?.trim();
      const maxIterations = maxIterationsRaw
        ? (() => {
            const n = Number.parseInt(maxIterationsRaw, 10);
            return n > 0 ? n : undefined;
          })()
        : undefined;

      try {
        await runHeadless({
          agent: {
            stream: (opts) =>
              agentManager.stream(opts.messages, {
                maxOutputTokens: opts.maxOutputTokens,
              }),
          },
          sessionId: sessionManager.getId(),
          emitEvent,
          initialUserMessage: {
            content: preparedPrompt.text,
            eventContent: promptArg,
            originalContent: preparedPrompt.originalText,
          },
          maxIterations,
          messageHistory,
          modelId: agentManager.getModelId(),
          onTodoReminder: async () => {
            const incompleteTodos = await getIncompleteTodos();
            if (incompleteTodos.length === 0) {
              return { hasReminder: false, message: null };
            }
            return {
              hasReminder: true,
              message: buildTodoContinuationUserMessage(incompleteTodos),
            };
          },
        });
      } catch (error) {
        emitEvent({
          timestamp: new Date().toISOString(),
          type: "error",
          sessionId: sessionManager.getId(),
          error: error instanceof Error ? error.message : String(error),
        });
        exitWithCleanup(1);
      }

      cleanup();
      console.error(
        `[headless] Completed in ${((Date.now() - headlessStartedAt) / 1000).toFixed(2)}s`
      );
      process.exit(0);
    }

    const skills: SkillInfo[] = await loadAllSkills();

    const showReasoningModeSelector = async (
      hooks: CommandPreprocessHooks
    ): Promise<ReasoningMode | null> => {
      hooks.clearStatus();

      const selectorContainer = new Container();
      const selectableModes = agentManager.getSelectableReasoningModes();
      const currentMode = agentManager.getReasoningMode();
      const descriptions: Partial<Record<ReasoningMode, string>> = {
        off: "Disable model reasoning output",
        on: "Enable model reasoning output",
        interleaved: "Interleave reasoning with normal response",
        preserved: "Preserve provider-native reasoning format",
      };
      const selectableSet = new Set(selectableModes);
      const modeItems: SelectItem[] = REASONING_MODES.filter((mode) => {
        return selectableSet.has(mode);
      }).map((mode) => {
        const parsedMode = parseReasoningMode(mode) ?? DEFAULT_REASONING_MODE;
        return {
          value: parsedMode,
          label: buildCurrentIndicatorLabel(
            parsedMode,
            parsedMode === currentMode
          ),
          description: descriptions[parsedMode],
        };
      });

      if (modeItems.length === 0) {
        return null;
      }

      const selectList = new SelectList(
        modeItems,
        10,
        hooks.editorTheme.selectList
      );
      const currentIndex = modeItems.findIndex(
        (item) => item.value === currentMode
      );
      if (currentIndex >= 0) {
        selectList.setSelectedIndex(currentIndex);
      }

      selectorContainer.addChild(
        new Text(style(ANSI_DIM, "Select reasoning mode"), 1, 0)
      );
      selectorContainer.addChild(new Spacer(1));
      selectorContainer.addChild(selectList);

      hooks.clearStatus();
      hooks.statusContainer.addChild(selectorContainer);
      hooks.tui.requestRender();

      return await new Promise<ReasoningMode | null>((resolve) => {
        let settled = false;
        let removeInputListener: (() => void) | null = null;

        const finish = (value: ReasoningMode | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (removeInputListener) {
            removeInputListener();
          }
          hooks.statusContainer.removeChild(selectorContainer);
          hooks.tui.requestRender();
          resolve(value);
        };

        selectList.onSelect = (item) => {
          finish(item.value as ReasoningMode);
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

    const showToolFallbackSelector = async (
      hooks: CommandPreprocessHooks
    ): Promise<ToolFallbackMode | null> => {
      hooks.clearStatus();

      const selectorContainer = new Container();
      const currentMode = agentManager.getToolFallbackMode();
      const descriptions: Record<ToolFallbackMode, string> = {
        disable: "Use native tool support only",
        morphxml: "XML tags per tool (MorphXML protocol)",
        hermes: "Hermes JSON-in-XML tool_call format",
        qwen3coder: "Qwen3Coder function-tag tool_call format",
      };

      const items: SelectItem[] = TOOL_FALLBACK_MODES.map((mode) => {
        const parsedMode = parseToolFallbackMode(mode) ?? mode;
        return {
          value: parsedMode,
          label: buildCurrentIndicatorLabel(
            parsedMode,
            parsedMode === currentMode
          ),
          description: descriptions[parsedMode],
        };
      });

      const selectList = new SelectList(
        items,
        10,
        hooks.editorTheme.selectList
      );
      const currentIndex = items.findIndex(
        (item) => item.value === currentMode
      );
      if (currentIndex >= 0) {
        selectList.setSelectedIndex(currentIndex);
      }
      selectorContainer.addChild(
        new Text(style(ANSI_DIM, "Select tool fallback mode"), 1, 0)
      );
      selectorContainer.addChild(new Spacer(1));
      selectorContainer.addChild(selectList);

      hooks.statusContainer.addChild(selectorContainer);
      hooks.tui.requestRender();

      return await new Promise<ToolFallbackMode | null>((resolve) => {
        let settled = false;
        let removeInputListener: (() => void) | null = null;

        const finish = (value: ToolFallbackMode | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (removeInputListener) {
            removeInputListener();
          }
          hooks.statusContainer.removeChild(selectorContainer);
          hooks.tui.requestRender();
          resolve(value);
        };

        selectList.onSelect = (item) => {
          finish(item.value as ToolFallbackMode);
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

    const showTranslateModeSelector = async (
      hooks: CommandPreprocessHooks
    ): Promise<boolean | null> => {
      hooks.clearStatus();

      const selectorContainer = new Container();
      const translationEnabled = agentManager.isTranslationEnabled();
      const items: SelectItem[] = [
        {
          value: "on",
          label: buildCurrentIndicatorLabel("on", translationEnabled),
          description: "Auto-translate non-English prompts",
        },
        {
          value: "off",
          label: buildCurrentIndicatorLabel("off", !translationEnabled),
          description: "Use prompts as entered",
        },
      ];

      const selectList = new SelectList(
        items,
        10,
        hooks.editorTheme.selectList
      );
      const currentIndex = translationEnabled ? 0 : 1;
      selectList.setSelectedIndex(currentIndex);
      selectorContainer.addChild(
        new Text(style(ANSI_DIM, "Select translation mode"), 1, 0)
      );
      selectorContainer.addChild(new Spacer(1));
      selectorContainer.addChild(selectList);

      hooks.statusContainer.addChild(selectorContainer);
      hooks.tui.requestRender();

      return await new Promise<boolean | null>((resolve) => {
        let settled = false;
        let removeInputListener: (() => void) | null = null;

        const finish = (value: boolean | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (removeInputListener) {
            removeInputListener();
          }
          hooks.statusContainer.removeChild(selectorContainer);
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

    const showModelSelector = async (
      models: ModelInfo[],
      currentModelId: string,
      currentProvider: ModelInfo["provider"],
      hooks: CommandPreprocessHooks,
      initialFilter = ""
    ): Promise<ModelInfo | null> => {
      hooks.clearStatus();

      const selectorContainer = new Container();
      const searchInput = new Input();
      searchInput.focused = true;
      searchInput.setValue(initialFilter);

      const items: SelectItem[] = models.map((model, index) => {
        const isCurrent =
          model.id === currentModelId && model.provider === currentProvider;
        return {
          value: String(index),
          label: buildModelSelectorLabel(model, isCurrent),
          description: buildModelSelectorDescription(model),
        };
      });

      const selectList = new SelectList(
        items,
        10,
        hooks.editorTheme.selectList
      );

      selectorContainer.addChild(
        new Text(style(ANSI_DIM, "Select model"), 1, 0)
      );
      selectorContainer.addChild(
        new Text(
          style(ANSI_DIM, "Type to filter, Enter to select, Esc to cancel"),
          1,
          0
        )
      );
      selectorContainer.addChild(new Spacer(1));
      selectorContainer.addChild(new Text(style(ANSI_DIM, "Search:"), 1, 0));
      selectorContainer.addChild(searchInput);
      selectorContainer.addChild(new Spacer(1));
      selectorContainer.addChild(selectList);

      hooks.statusContainer.addChild(selectorContainer);
      selectList.setFilter(initialFilter);
      if (!initialFilter) {
        const currentIndex = items.findIndex((_item, i) => {
          const model = models[i];
          return (
            model.id === currentModelId && model.provider === currentProvider
          );
        });
        if (currentIndex >= 0) {
          selectList.setSelectedIndex(currentIndex);
        }
      }
      hooks.tui.requestRender();

      return await new Promise<ModelInfo | null>((resolve) => {
        let settled = false;
        let removeInputListener: (() => void) | null = null;

        const finish = (value: ModelInfo | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (removeInputListener) {
            removeInputListener();
          }
          hooks.statusContainer.removeChild(selectorContainer);
          hooks.tui.requestRender();
          resolve(value);
        };

        selectList.onSelect = (item) => {
          const selectedIndex = Number.parseInt(item.value, 10);
          finish(models[selectedIndex] ?? null);
        };
        selectList.onCancel = () => {
          finish(null);
        };

        removeInputListener = hooks.addInputListener((data: string) => {
          if (hooks.isCtrlCInput(data)) {
            finish(null);
            return { consume: true };
          }

          const isNavigationInput =
            matchesKey(data, Key.up) ||
            matchesKey(data, Key.down) ||
            matchesKey(data, Key.enter) ||
            matchesKey(data, Key.escape);

          if (isNavigationInput) {
            selectList.handleInput(data);
          } else {
            searchInput.handleInput(data);
            selectList.setFilter(searchInput.getValue());
          }

          hooks.tui.requestRender();
          return { consume: true };
        });
      });
    };

    const handleModelCommand = async (
      commandInput: string,
      parsed: { name: string; args: string[] },
      hooks: CommandPreprocessHooks
    ): Promise<string | null> => {
      const models = getAvailableModels();
      if (models.length === 0) {
        return commandInput;
      }

      const searchTerm = parsed.args[0]?.trim() ?? "";

      if (parsed.args.length > 0 && findModelBySelection(searchTerm, models)) {
        return commandInput;
      }

      const selectedModel = await showModelSelector(
        models,
        agentManager.getModelId(),
        agentManager.getProvider(),
        hooks,
        searchTerm
      );

      if (!selectedModel) {
        return null;
      }

      const result = applyModelSelection(selectedModel);
      await updateCompactionForCurrentModel();
      if (result.message) {
        hooks.showMessage(result.message);
      }
      hooks.updateHeader();
      return null;
    };

    const handleReasoningModeSelectorCommand = async (
      parsed: { name: string; args: string[] },
      hooks: CommandPreprocessHooks
    ): Promise<string | null | undefined> => {
      if (
        !(parsed.name === "reasoning-mode" || parsed.name === "think") ||
        parsed.args.length > 0
      ) {
        return undefined;
      }

      const selected = await showReasoningModeSelector(hooks);
      return selected ? `/reasoning-mode ${selected}` : null;
    };

    const handleToolFallbackSelectorCommand = async (
      parsed: { name: string; args: string[] },
      hooks: CommandPreprocessHooks
    ): Promise<string | null | undefined> => {
      if (parsed.name !== "tool-fallback" || parsed.args.length > 0) {
        return undefined;
      }

      const selected = await showToolFallbackSelector(hooks);
      return selected ? `/tool-fallback ${selected}` : null;
    };

    const handleTranslateSelectorCommand = async (
      parsed: { name: string; args: string[] },
      hooks: CommandPreprocessHooks
    ): Promise<string | null | undefined> => {
      if (parsed.name !== "translate" || parsed.args.length > 0) {
        return undefined;
      }

      const selected = await showTranslateModeSelector(hooks);
      if (selected === null) {
        return null;
      }

      const mode = selected ? "on" : "off";
      return `/translate ${mode}`;
    };

    const preprocessSimpleSelectorCommand = async (
      parsed: { name: string; args: string[] },
      hooks: CommandPreprocessHooks
    ): Promise<string | null | undefined> => {
      const reasoningResult = await handleReasoningModeSelectorCommand(
        parsed,
        hooks
      );
      if (reasoningResult !== undefined) {
        return reasoningResult;
      }

      const fallbackResult = await handleToolFallbackSelectorCommand(
        parsed,
        hooks
      );
      if (fallbackResult !== undefined) {
        return fallbackResult;
      }

      const translateResult = await handleTranslateSelectorCommand(
        parsed,
        hooks
      );
      if (translateResult !== undefined) {
        return translateResult;
      }

      return undefined;
    };

    const createCommandPreprocessor = () => {
      return async (
        commandInput: string,
        hooks: CommandPreprocessHooks
      ): Promise<string | null> => {
        const parsed = parseCommand(commandInput);
        if (!parsed) {
          return commandInput;
        }

        if (parsed.name === "model") {
          return handleModelCommand(commandInput, parsed, hooks);
        }

        const selectorResult = await preprocessSimpleSelectorCommand(
          parsed,
          hooks
        );
        if (selectorResult !== undefined) {
          return selectorResult;
        }

        return commandInput;
      };
    };

    try {
      await createAgentTUI({
        agent: buildAgentStreamWithTodoContinuation(),
        messageHistory,
        skills,
        commands: createCliCommands(),
        footer: {
          get text() {
            const contextUsage = messageHistory.getContextUsage();
            if (!contextUsage) {
              return undefined;
            }
            return formatContextUsage(contextUsage);
          },
        },
        header: {
          title: "Code Editing Agent",
          get subtitle() {
            const modelInfo = `${agentManager.getProvider()}/${agentManager.getModelId()}`;
            return `${modelInfo}\nSession: ${sessionManager.getId()}`;
          },
        },
        theme: {
          markdownTheme: createMarkdownTheme(),
          editorTheme: createEditorTheme(),
        },
        toolRenderers: createToolRenderers(),
        showRawToolIo: env.DEBUG_SHOW_RAW_TOOL_IO,
        preprocessCommand: createCommandPreprocessor(),
        preprocessUserInput: createTranslationPreprocessor(),
        onCommandAction: (action) => {
          if (action.type === "new-session") {
            sessionManager.initialize();
            resetMissingLinesFailures();
          }
        },
        onSetup: () => {
          setSpinnerOutputEnabled(false);
        },
      });
    } finally {
      cleanup();
      setSpinnerOutputEnabled(true);
    }

    process.exit(requestedProcessExitCode ?? 0);
  },
});

runMain(mainCommand, { rawArgs: normalizeRawArgs(process.argv.slice(2)) });
