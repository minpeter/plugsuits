#!/usr/bin/env bun

import { stripVTControlCharacters } from "node:util";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  type EditorTheme,
  Input,
  Key,
  Loader,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  SelectList,
  type SlashCommand,
  Spacer,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import type { ProviderType } from "../agent";
import { agentManager } from "../agent";
import {
  executeCommand,
  getCommands,
  isCommand,
  isSkillCommandResult,
  parseCommand,
  registerCommand,
  resolveRegisteredCommandName,
} from "../commands";
import { createClearCommand } from "../commands/clear";
import {
  applyModelSelection,
  createModelCommand,
  findModelBySelection,
  getAvailableModels,
  type ModelInfo,
} from "../commands/model";
import { createRenderCommand } from "../commands/render";
import { createThinkCommand } from "../commands/think";
import { createToolFallbackCommand } from "../commands/tool-fallback";
import { MessageHistory } from "../context/message-history";
import { getSessionId, initializeSession } from "../context/session";
import type { SkillInfo } from "../context/skills";
import { loadAllSkills } from "../context/skills";
import { env } from "../env";
import { renderFullStreamWithPiTui } from "../interaction/pi-tui-stream-renderer";
import { setSpinnerOutputEnabled } from "../interaction/spinner";
import {
  MANUAL_TOOL_LOOP_MAX_STEPS,
  shouldContinueManualToolLoop,
} from "../interaction/tool-loop-control";
import {
  buildTodoContinuationUserMessage,
  getIncompleteTodos,
} from "../middleware/todo-continuation";
import {
  DEFAULT_TOOL_FALLBACK_MODE,
  LEGACY_ENABLED_TOOL_FALLBACK_MODE,
  parseToolFallbackMode,
  TOOL_FALLBACK_MODES,
  type ToolFallbackMode,
} from "../tool-fallback-mode";
import { cleanupSession } from "../tools/execute/shared-tmux-session";
import { initializeTools } from "../utils/tools-manager";

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_ITALIC = "\x1b[3m";
const ANSI_UNDERLINE = "\x1b[4m";
const ANSI_BG_GRAY = "\x1b[100m";
const ANSI_GREEN = "\x1b[92m";
const ANSI_YELLOW = "\x1b[93m";
const ANSI_MAGENTA = "\x1b[95m";
const ANSI_CYAN = "\x1b[96m";
const ANSI_BRIGHT_CYAN = "\x1b[96m";
const ANSI_GRAY = "\x1b[90m";

const messageHistory = new MessageHistory();
let cachedSkills: SkillInfo[] = [];
let shouldExit = false;

const style = (prefix: string, text: string): string => {
  return `${prefix}${text}${ANSI_RESET}`;
};

const sanitizeCodeFence = (text: string): string => {
  return text.replaceAll("```", "` ` `");
};

const stripAnsi = (value: string): string => {
  if (typeof stripVTControlCharacters === "function") {
    return stripVTControlCharacters(value);
  }

  let output = "";
  let index = 0;

  while (index < value.length) {
    const char = value[index];
    if (char === "\u001b") {
      index += 1;
      if (index < value.length && value[index] === "[") {
        index += 1;
        while (index < value.length) {
          const code = value.charCodeAt(index);
          index += 1;
          if (code >= 0x40 && code <= 0x7e) {
            break;
          }
        }
      }
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
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

const addUserMessage = (
  chatContainer: Container,
  markdownTheme: MarkdownTheme,
  message: string
): void => {
  chatContainer.addChild(new Spacer(1));
  chatContainer.addChild(
    new Markdown(message, 1, 1, markdownTheme, {
      bgColor: (text: string) => style(ANSI_BG_GRAY, text),
    })
  );
};

const addSystemMessage = (chatContainer: Container, message: string): void => {
  const cleaned = stripAnsi(message).trimEnd();

  if (cleaned.length === 0) {
    return;
  }

  chatContainer.addChild(new Spacer(1));
  chatContainer.addChild(
    new Text(style(ANSI_GRAY, sanitizeCodeFence(cleaned)), 1, 0)
  );
};

const addNewSessionMessage = (chatContainer: Container): void => {
  chatContainer.addChild(new Spacer(1));
  chatContainer.addChild(
    new Text(style(ANSI_BRIGHT_CYAN, "✓ New session started"), 1, 1)
  );
};

const createAutocompleteCommands = (skills: SkillInfo[]): SlashCommand[] => {
  const createCommandSuggestion = (
    command: {
      argumentSuggestions?: string[];
      description: string;
      name: string;
    },
    name: string,
    description: string
  ): SlashCommand => {
    const suggestions = command.argumentSuggestions;

    return {
      name,
      description,
      getArgumentCompletions:
        suggestions && suggestions.length > 0
          ? (argumentPrefix: string) => {
              const matches = suggestions.filter((suggestion) =>
                suggestion
                  .toLowerCase()
                  .startsWith(argumentPrefix.toLowerCase())
              );

              if (matches.length === 0) {
                return null;
              }

              return matches.map((match) => ({
                value: match,
                label: match,
              }));
            }
          : undefined,
    } satisfies SlashCommand;
  };

  const commandSuggestions = Array.from(getCommands().values()).flatMap(
    (command) => {
      const aliases =
        "aliases" in command && Array.isArray(command.aliases)
          ? command.aliases
          : [];
      const aliasSuffix =
        aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";

      const primary = createCommandSuggestion(
        command,
        command.name,
        `${command.description}${aliasSuffix}`
      );

      const aliasSuggestions = aliases.map((alias: string) =>
        createCommandSuggestion(
          command,
          alias,
          `Alias of /${command.name} - ${command.description}`
        )
      );

      return [primary, ...aliasSuggestions];
    }
  );

  const skillSuggestions: SlashCommand[] = skills.map((skill) => ({
    name: skill.id,
    description: skill.description,
  }));

  return [...commandSuggestions, ...skillSuggestions];
};

interface CliUi {
  chatContainer: Container;
  clearStatus: () => void;
  dispose: () => void;
  editor: Editor;
  markdownTheme: MarkdownTheme;
  requestExit: () => void;
  showLoader: (message: string) => void;
  showModelSelector: (
    models: ModelInfo[],
    currentModelId: string,
    currentProvider: ProviderType,
    initialFilter?: string
  ) => Promise<ModelInfo | null>;
  showThinkSelector: (currentEnabled: boolean) => Promise<"on" | "off" | null>;
  showToolFallbackSelector: (
    currentMode: ToolFallbackMode
  ) => Promise<ToolFallbackMode | null>;
  tui: TUI;
  updateHeader: () => void;
  waitForInput: () => Promise<string | null>;
}

const createCliUi = (skills: SkillInfo[]): CliUi => {
  const markdownTheme = createMarkdownTheme();
  const tui = new TUI(new ProcessTerminal());
  tui.setClearOnShrink(true);
  const headerContainer = new Container();
  const chatContainer = new Container();
  const statusContainer = new Container();
  const editorContainer = new Container();

  const title = new Text("", 1, 0);
  const help = new Text(
    style(
      ANSI_DIM,
      "Enter to submit, Shift+Enter for newline, /help for commands, Ctrl+C to exit"
    ),
    1,
    0
  );

  const updateHeader = (): void => {
    const sessionId = getSessionId();
    const provider = agentManager.getProvider();
    const model = agentManager.getModelId();
    title.setText(
      `${style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, "Code Editing Agent")} ${style(
        ANSI_DIM,
        `${provider}/${model}`
      )}\n${style(ANSI_DIM, `Session: ${sessionId}`)}`
    );
    tui.requestRender();
  };

  headerContainer.addChild(new Spacer(1));
  headerContainer.addChild(title);
  headerContainer.addChild(help);
  headerContainer.addChild(new Spacer(1));

  const editorTheme = createEditorTheme();
  const editor = new Editor(tui, editorTheme, {
    paddingX: 1,
    autocompleteMaxVisible: 8,
  });
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      createAutocompleteCommands(skills),
      process.cwd()
    )
  );

  editorContainer.addChild(editor);

  tui.addChild(headerContainer);
  tui.addChild(chatContainer);
  tui.addChild(statusContainer);
  tui.addChild(editorContainer);
  tui.setFocus(editor);

  let loader: Loader | null = null;
  let inputResolver: ((value: string | null) => void) | null = null;

  const clearStatus = (): void => {
    if (loader) {
      loader.stop();
      statusContainer.removeChild(loader);
      loader = null;
    }
    statusContainer.clear();
    tui.requestRender();
  };

  const showLoader = (message: string): void => {
    clearStatus();
    loader = new Loader(
      tui,
      (text: string) => style(ANSI_CYAN, text),
      (text: string) => style(ANSI_DIM, text),
      message
    );
    statusContainer.addChild(loader);
    loader.start();
    tui.requestRender();
  };

  const showThinkSelector = async (
    currentEnabled: boolean
  ): Promise<"on" | "off" | null> => {
    clearStatus();

    const selectorContainer = new Container();
    selectorContainer.addChild(
      new Text(style(ANSI_DIM, "Select reasoning execution"), 1, 0)
    );
    selectorContainer.addChild(new Spacer(1));

    const selectList = new SelectList(
      [
        {
          value: "on",
          label: "on",
          description: "Enable model reasoning",
        },
        {
          value: "off",
          label: "off",
          description: "Disable model reasoning",
        },
      ],
      2,
      editorTheme.selectList
    );
    selectList.setSelectedIndex(currentEnabled ? 0 : 1);

    selectorContainer.addChild(selectList);
    statusContainer.addChild(selectorContainer);
    tui.requestRender();

    return await new Promise((resolve) => {
      let removeSelectorInputListener: () => void = () => undefined;
      let done = false;

      const cleanup = (): void => {
        removeSelectorInputListener();
        statusContainer.removeChild(selectorContainer);
        tui.requestRender();
      };

      const finish = (value: "on" | "off" | null): void => {
        if (done) {
          return;
        }
        done = true;
        cleanup();
        resolve(value);
      };

      selectList.onSelect = (item) => {
        finish(item.value === "off" ? "off" : "on");
      };
      selectList.onCancel = () => {
        finish(null);
      };

      removeSelectorInputListener = tui.addInputListener((data) => {
        if (matchesKey(data, Key.ctrl("c"))) {
          requestExit();
          finish(null);
          return { consume: true };
        }

        selectList.handleInput(data);
        tui.requestRender();
        return { consume: true };
      });
    });
  };

  const showToolFallbackSelector = async (
    currentMode: ToolFallbackMode
  ): Promise<ToolFallbackMode | null> => {
    clearStatus();

    const selectorContainer = new Container();
    selectorContainer.addChild(
      new Text(style(ANSI_DIM, "Select tool fallback mode"), 1, 0)
    );
    selectorContainer.addChild(new Spacer(1));

    const selectList = new SelectList(
      [
        {
          value: "disable",
          label: "disable",
          description: "Use native tool support only",
        },
        {
          value: "morphxml",
          label: "morphxml",
          description: "XML tags per tool (MorphXML protocol)",
        },
        {
          value: "hermes",
          label: "hermes",
          description: "Hermes JSON-in-XML tool_call format",
        },
        {
          value: "qwen3coder",
          label: "qwen3coder",
          description: "Qwen3Coder function-tag tool_call format",
        },
      ],
      4,
      editorTheme.selectList
    );
    const currentModeIndex = TOOL_FALLBACK_MODES.indexOf(currentMode);
    if (currentModeIndex >= 0) {
      selectList.setSelectedIndex(currentModeIndex);
    }

    selectorContainer.addChild(selectList);
    statusContainer.addChild(selectorContainer);
    tui.requestRender();

    return await new Promise((resolve) => {
      let removeSelectorInputListener: () => void = () => undefined;
      let done = false;

      const cleanup = (): void => {
        removeSelectorInputListener();
        statusContainer.removeChild(selectorContainer);
        tui.requestRender();
      };

      const finish = (value: ToolFallbackMode | null): void => {
        if (done) {
          return;
        }
        done = true;
        cleanup();
        resolve(value);
      };

      selectList.onSelect = (item) => {
        const parsedMode = parseToolFallbackMode(item.value);
        finish(parsedMode);
      };
      selectList.onCancel = () => {
        finish(null);
      };

      removeSelectorInputListener = tui.addInputListener((data) => {
        if (matchesKey(data, Key.ctrl("c"))) {
          requestExit();
          finish(null);
          return { consume: true };
        }

        selectList.handleInput(data);
        tui.requestRender();
        return { consume: true };
      });
    });
  };

  const showModelSelector = async (
    models: ModelInfo[],
    currentModelId: string,
    currentProvider: ProviderType,
    initialFilter = ""
  ): Promise<ModelInfo | null> => {
    clearStatus();

    const selectorContainer = new Container();
    selectorContainer.addChild(new Text(style(ANSI_DIM, "Select model"), 1, 0));
    selectorContainer.addChild(new Spacer(1));

    const searchInput = new Input();
    searchInput.focused = true;
    searchInput.setValue(initialFilter);
    selectorContainer.addChild(searchInput);
    selectorContainer.addChild(new Spacer(1));

    const modelMap = new Map<string, ModelInfo>();
    const items = models.map((model) => {
      const key = `${model.provider}:${model.id}`;
      modelMap.set(key, model);
      const providerLabel =
        model.provider === "anthropic" ? "Anthropic" : "FriendliAI";
      const modelName = model.name ? ` - ${model.name}` : "";
      const isCurrent =
        model.id === currentModelId && model.provider === currentProvider;
      const currentLabel = isCurrent ? " (current)" : "";
      return {
        value: key,
        label: `${model.id}${modelName}`,
        description: `${providerLabel}${currentLabel}`,
      };
    });

    const selectList = new SelectList(items, 10, editorTheme.selectList);
    const currentIndex = items.findIndex(
      (item) => item.value === `${currentProvider}:${currentModelId}`
    );
    if (currentIndex >= 0) {
      selectList.setSelectedIndex(currentIndex);
    }

    if (initialFilter.length > 0) {
      selectList.setFilter(initialFilter);
    }

    selectorContainer.addChild(selectList);
    selectorContainer.addChild(new Spacer(1));
    selectorContainer.addChild(
      new Text(
        style(ANSI_DIM, "Type to filter, Enter to select, Esc to cancel"),
        1,
        0
      )
    );
    statusContainer.addChild(selectorContainer);
    tui.requestRender();

    return await new Promise((resolve) => {
      let removeSelectorInputListener: () => void = () => undefined;
      let done = false;

      const cleanup = (): void => {
        removeSelectorInputListener();
        statusContainer.removeChild(selectorContainer);
        searchInput.focused = false;
        tui.requestRender();
      };

      const finish = (value: ModelInfo | null): void => {
        if (done) {
          return;
        }
        done = true;
        cleanup();
        resolve(value);
      };

      const selectCurrent = (): void => {
        const selectedItem = selectList.getSelectedItem();
        if (!selectedItem) {
          return;
        }
        finish(modelMap.get(selectedItem.value) ?? null);
      };

      selectList.onSelect = (item) => {
        finish(modelMap.get(item.value) ?? null);
      };
      selectList.onCancel = () => {
        finish(null);
      };
      searchInput.onSubmit = () => {
        selectCurrent();
      };
      searchInput.onEscape = () => {
        finish(null);
      };

      removeSelectorInputListener = tui.addInputListener((data) => {
        if (matchesKey(data, Key.ctrl("c"))) {
          requestExit();
          finish(null);
          return { consume: true };
        }

        if (
          matchesKey(data, Key.up) ||
          matchesKey(data, Key.down) ||
          matchesKey(data, Key.enter) ||
          matchesKey(data, Key.escape)
        ) {
          selectList.handleInput(data);
          tui.requestRender();
          return { consume: true };
        }

        searchInput.handleInput(data);
        selectList.setFilter(searchInput.getValue());
        tui.requestRender();
        return { consume: true };
      });
    });
  };

  const requestExit = (): void => {
    shouldExit = true;
    if (inputResolver) {
      const resolve = inputResolver;
      inputResolver = null;
      resolve(null);
    }
  };

  const onSigInt = () => {
    requestExit();
  };

  const onTerminalResize = () => {
    tui.requestRender(true);
  };

  const removeInputListener = tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      requestExit();
      return { consume: true };
    }
    return undefined;
  });

  process.on("SIGINT", onSigInt);
  process.stdout.on("resize", onTerminalResize);

  editor.onSubmit = (text: string) => {
    if (!inputResolver) {
      return;
    }

    const resolve = inputResolver;
    inputResolver = null;
    resolve(text);
  };

  const waitForInput = (): Promise<string | null> => {
    return new Promise((resolve) => {
      inputResolver = resolve;
      tui.setFocus(editor);
      tui.requestRender();
    });
  };

  const dispose = (): void => {
    clearStatus();

    if (inputResolver) {
      const resolve = inputResolver;
      inputResolver = null;
      resolve(null);
    }

    removeInputListener();
    process.off("SIGINT", onSigInt);
    process.stdout.off("resize", onTerminalResize);
    tui.stop();
  };

  updateHeader();
  tui.start();

  return {
    tui,
    editor,
    chatContainer,
    markdownTheme,
    updateHeader,
    waitForInput,
    requestExit,
    showLoader,
    showModelSelector,
    showToolFallbackSelector,
    showThinkSelector,
    clearStatus,
    dispose,
  };
};

registerCommand(
  createRenderCommand(async () => ({
    model: agentManager.getModelId(),
    modelType: agentManager.getModelType(),
    instructions: await agentManager.getInstructions(),
    tools: agentManager.getTools(),
    messages: messageHistory.toModelMessages(),
    thinkingEnabled: agentManager.isThinkingEnabled(),
    toolFallbackMode: agentManager.getToolFallbackMode(),
  }))
);
registerCommand(createModelCommand());
registerCommand(createClearCommand());
registerCommand(createThinkCommand());
registerCommand(createToolFallbackCommand());

const parseProviderArg = (
  providerArg: string | undefined
): ProviderType | null => {
  if (providerArg === "anthropic" || providerArg === "friendli") {
    return providerArg;
  }

  return null;
};

const parseToolFallbackCliOption = (
  args: string[],
  index: number
): { consumedArgs: number; mode: ToolFallbackMode } | null => {
  const arg = args[index];

  if (arg === "--tool-fallback-mode") {
    const parsedMode = parseToolFallbackMode(args[index + 1] ?? "");
    return {
      consumedArgs: 1,
      mode: parsedMode ?? DEFAULT_TOOL_FALLBACK_MODE,
    };
  }

  if (arg !== "--tool-fallback") {
    return null;
  }

  const candidate = args[index + 1];
  if (candidate && !candidate.startsWith("--")) {
    const parsedMode = parseToolFallbackMode(candidate);
    return {
      consumedArgs: 1,
      mode: parsedMode ?? LEGACY_ENABLED_TOOL_FALLBACK_MODE,
    };
  }

  return {
    consumedArgs: 0,
    mode: LEGACY_ENABLED_TOOL_FALLBACK_MODE,
  };
};

const parseCliArgs = (): {
  thinking: boolean;
  toolFallbackMode: ToolFallbackMode;
  model: string | null;
  provider: ProviderType | null;
} => {
  const args = process.argv.slice(2);
  let thinking = false;
  let toolFallbackMode: ToolFallbackMode = DEFAULT_TOOL_FALLBACK_MODE;
  let model: string | null = null;
  let provider: ProviderType | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--think") {
      thinking = true;
      continue;
    }

    const toolFallbackOption = parseToolFallbackCliOption(args, i);
    if (toolFallbackOption) {
      toolFallbackMode = toolFallbackOption.mode;
      i += toolFallbackOption.consumedArgs;
      continue;
    }

    if (arg === "--model" && i + 1 < args.length) {
      model = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--provider" && i + 1 < args.length) {
      provider = parseProviderArg(args[i + 1]) ?? provider;
      i += 1;
    }
  }

  return { thinking, toolFallbackMode, model, provider };
};

const setupAgent = (): void => {
  const { thinking, toolFallbackMode, model, provider } = parseCliArgs();
  agentManager.setThinkingEnabled(thinking);
  agentManager.setToolFallbackMode(toolFallbackMode);
  if (provider) {
    agentManager.setProvider(provider);
  }
  if (model) {
    agentManager.setModelId(model);
  }
};

const processAgentResponse = async (ui: CliUi): Promise<void> => {
  ui.showLoader("Thinking...");
  let manualToolLoopCount = 0;

  while (true) {
    const stream = await agentManager.stream(messageHistory.toModelMessages());
    ui.clearStatus();

    await renderFullStreamWithPiTui(stream.fullStream, {
      ui: ui.tui,
      chatContainer: ui.chatContainer,
      markdownTheme: ui.markdownTheme,
      showReasoning: true,
      showSteps: false,
      showToolResults: true,
      showFiles: false,
      showSources: false,
      showFinishReason: env.DEBUG_SHOW_FINISH_REASON,
    });

    const [response, finishReason] = await Promise.all([
      stream.response,
      stream.finishReason,
    ]);
    messageHistory.addModelMessages(response.messages);

    if (!shouldContinueManualToolLoop(finishReason)) {
      return;
    }

    manualToolLoopCount += 1;
    if (manualToolLoopCount >= MANUAL_TOOL_LOOP_MAX_STEPS) {
      addSystemMessage(
        ui.chatContainer,
        `[agent] Manual tool loop safety cap reached (${MANUAL_TOOL_LOOP_MAX_STEPS}); waiting for input.`
      );
      ui.tui.requestRender();
      return;
    }

    ui.showLoader("Continuing...");
  }
};

const handleAgentResponse = async (ui: CliUi): Promise<void> => {
  while (true) {
    await processAgentResponse(ui);

    const incompleteTodos = await getIncompleteTodos();
    if (incompleteTodos.length === 0) {
      return;
    }

    const reminder = buildTodoContinuationUserMessage(incompleteTodos);
    messageHistory.addUserMessage(reminder);
  }
};

const renderCommandMessage = (ui: CliUi, message: string): void => {
  addSystemMessage(ui.chatContainer, message);
  ui.updateHeader();
  ui.tui.requestRender();
};

const handleModelCommand = async (
  ui: CliUi,
  commandInput: string,
  parsed: ReturnType<typeof parseCommand>
): Promise<boolean | null> => {
  if (parsed?.name !== "model") {
    return null;
  }

  const models = getAvailableModels();
  if (models.length === 0) {
    const result = await executeCommand(commandInput);
    if (result?.message) {
      renderCommandMessage(ui, result.message);
      return true;
    }
    return false;
  }

  const searchTerm = parsed.args[0]?.trim() ?? "";
  const exactMatch =
    searchTerm.length > 0
      ? findModelBySelection(searchTerm, models)
      : undefined;

  if (parsed.args.length > 0 && exactMatch) {
    return null;
  }

  const selectedModel = await ui.showModelSelector(
    models,
    agentManager.getModelId(),
    agentManager.getProvider(),
    searchTerm
  );
  if (!selectedModel) {
    return true;
  }

  const selectionResult = applyModelSelection(selectedModel);
  if (selectionResult.message) {
    renderCommandMessage(ui, selectionResult.message);
    return true;
  }

  ui.updateHeader();
  ui.tui.requestRender();
  return true;
};

const resolveToolFallbackCommandInput = async (
  ui: CliUi,
  commandInput: string,
  parsed: ReturnType<typeof parseCommand>
): Promise<string | null> => {
  if (parsed?.name !== "tool-fallback" || parsed.args.length > 0) {
    return commandInput;
  }

  const selected = await ui.showToolFallbackSelector(
    agentManager.getToolFallbackMode()
  );
  if (!selected) {
    return null;
  }

  return `/tool-fallback ${selected}`;
};

const resolveThinkCommandInput = async (
  ui: CliUi,
  commandInput: string,
  parsed: ReturnType<typeof parseCommand>
): Promise<string | null> => {
  if (parsed?.name !== "think" || parsed.args.length > 0) {
    return commandInput;
  }

  const selected = await ui.showThinkSelector(agentManager.isThinkingEnabled());
  if (!selected) {
    return null;
  }

  return `/think ${selected}`;
};

const handleCommand = async (ui: CliUi, input: string): Promise<boolean> => {
  let commandInput = input;
  const initialParsed = parseCommand(commandInput);

  const modelHandled = await handleModelCommand(
    ui,
    commandInput,
    initialParsed
  );
  if (modelHandled !== null) {
    return modelHandled;
  }

  const toolFallbackCommandInput = await resolveToolFallbackCommandInput(
    ui,
    commandInput,
    initialParsed
  );
  if (!toolFallbackCommandInput) {
    return true;
  }
  commandInput = toolFallbackCommandInput;

  const thinkCommandInput = await resolveThinkCommandInput(
    ui,
    commandInput,
    initialParsed
  );
  if (!thinkCommandInput) {
    return true;
  }
  commandInput = thinkCommandInput;

  const parsed = parseCommand(commandInput);
  const resolvedCommandName = parsed
    ? resolveRegisteredCommandName(parsed.name)
    : null;
  const isNativeCommand =
    resolvedCommandName === "clear" ||
    resolvedCommandName === "think" ||
    resolvedCommandName === "tool-fallback";

  if (!isNativeCommand) {
    ui.showLoader("Running command...");
  }

  const result = await executeCommand(commandInput);

  if (!isNativeCommand) {
    ui.clearStatus();
  }

  if (result?.action === "new-session") {
    ui.clearStatus();
    initializeSession();
    messageHistory.clear();
    ui.chatContainer.clear();
    addNewSessionMessage(ui.chatContainer);
    ui.updateHeader();
    ui.tui.requestRender();
    return true;
  }

  if (isSkillCommandResult(result)) {
    const skillMessage = `<command-name>/${result.skillId}</command-name>\n\n${result.skillContent}`;
    messageHistory.addUserMessage(skillMessage);
    await handleAgentResponse(ui);
    return true;
  }

  if (result?.message) {
    renderCommandMessage(ui, result.message);
    return true;
  }

  return false;
};

const processInput = async (ui: CliUi, input: string): Promise<boolean> => {
  const trimmed = input.trim();

  if (shouldExit || trimmed.length === 0 || trimmed.toLowerCase() === "exit") {
    return false;
  }

  ui.editor.disableSubmit = true;
  try {
    if (isCommand(trimmed)) {
      addUserMessage(ui.chatContainer, ui.markdownTheme, trimmed);
      ui.tui.requestRender();
      return await handleCommand(ui, trimmed);
    }

    addUserMessage(ui.chatContainer, ui.markdownTheme, trimmed);
    messageHistory.addUserMessage(trimmed);
    ui.tui.requestRender();
    await handleAgentResponse(ui);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    addSystemMessage(ui.chatContainer, `Error: ${errorMessage}`);
    ui.tui.requestRender();
    return true;
  } finally {
    ui.editor.disableSubmit = false;
    ui.editor.setText("");
    ui.tui.setFocus(ui.editor);
    ui.tui.requestRender();
  }
};

const run = async (): Promise<void> => {
  await initializeTools();
  cachedSkills = await loadAllSkills();
  setSpinnerOutputEnabled(false);

  initializeSession();
  setupAgent();

  const ui = createCliUi(cachedSkills);

  try {
    while (!shouldExit) {
      const input = await ui.waitForInput();
      if (input === null) {
        break;
      }

      const shouldContinue = await processInput(ui, input);
      if (!shouldContinue) {
        break;
      }
    }
  } finally {
    ui.dispose();
    cleanupSession();
    setSpinnerOutputEnabled(true);
  }
};

process.on("exit", () => {
  cleanupSession();
});

run().catch((error: unknown) => {
  throw error instanceof Error ? error : new Error("Failed to run CLI.");
});
