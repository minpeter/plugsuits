#!/usr/bin/env bun

import { stripVTControlCharacters } from "node:util";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  type EditorTheme,
  Input,
  isKeyRelease,
  isKeyRepeat,
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
import { createReasoningModeCommand } from "../commands/reasoning-mode";
import { createRenderCommand } from "../commands/render";
import { createToolFallbackCommand } from "../commands/tool-fallback";
import { createTranslateCommand } from "../commands/translate";
import { MessageHistory } from "../context/message-history";
import { getSessionId, initializeSession } from "../context/session";
import { toPromptsCommandName } from "../context/skill-command-prefix";
import type { SkillInfo } from "../context/skills";
import { loadAllSkills } from "../context/skills";
import { isNonEnglish, translateToEnglish } from "../context/translation";
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
  DEFAULT_REASONING_MODE,
  parseReasoningMode,
  type ReasoningMode,
} from "../reasoning-mode";
import {
  DEFAULT_TOOL_FALLBACK_MODE,
  LEGACY_ENABLED_TOOL_FALLBACK_MODE,
  parseToolFallbackMode,
  TOOL_FALLBACK_MODES,
  type ToolFallbackMode,
} from "../tool-fallback-mode";
import { cleanup } from "../tools/utils/execute/process-manager";
import { initializeTools } from "../utils/tools-manager";

const ANSI_RESET = "\x1b[0m";
const ANSI_BLACK = "\x1b[30m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_ITALIC = "\x1b[3m";
const ANSI_UNDERLINE = "\x1b[4m";
const ANSI_BG_GRAY = "\x1b[100m";
const ANSI_BG_SOFT_LIGHT = "\x1b[48;5;249m";
const ANSI_GREEN = "\x1b[92m";
const ANSI_YELLOW = "\x1b[93m";
const ANSI_MAGENTA = "\x1b[95m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_BRIGHT_CYAN = "\x1b[96m";
const ANSI_GRAY = "\x1b[90m";
const CTRL_C_ETX = "\u0003";
const CTRL_C_EXIT_WINDOW_MS = 500;

const messageHistory = new MessageHistory();
let cachedSkills: SkillInfo[] = [];
let shouldExit = false;
let activeStreamController: AbortController | null = null;
let streamInterruptRequested = false;

const cancelActiveStream = (): boolean => {
  if (!activeStreamController || activeStreamController.signal.aborted) {
    return false;
  }

  streamInterruptRequested = true;
  activeStreamController.abort("User requested stream interruption");
  return true;
};

const clearActiveStreamController = (
  streamController: AbortController
): void => {
  if (activeStreamController === streamController) {
    activeStreamController = null;
  }
};

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
      bgColor: (text: string) =>
        style(`${ANSI_BG_SOFT_LIGHT}${ANSI_BLACK}`, text),
    })
  );
};

const addTranslatedMessage = (
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

const SKILL_LABEL_MAX_WIDTH = 24;
const MODEL_LABEL_MAX_WIDTH = 26;
const MODEL_NAME_MAX_WIDTH = 28;

type SlashAutocompleteEntry = SlashCommand | AutocompleteItem;

const truncateAutocompleteLabel = (value: string, maxWidth: number): string => {
  if (value.length <= maxWidth) {
    return value;
  }

  if (maxWidth <= 1) {
    return "…";
  }

  return `${value.slice(0, maxWidth - 1)}…`;
};

const toAutocompleteEntryValue = (entry: SlashAutocompleteEntry): string => {
  return "name" in entry ? entry.name : entry.value;
};

const buildModelSelectorDescription = (
  modelName: string | undefined,
  providerLabel: string
): string => {
  if (!modelName) {
    return providerLabel;
  }

  const truncatedName = truncateAutocompleteLabel(
    modelName,
    MODEL_NAME_MAX_WIDTH
  );
  return `${truncatedName} - ${providerLabel}`;
};

const buildModelSelectorLabel = (
  modelId: string,
  isCurrent: boolean
): string => {
  const currentMarker = isCurrent ? "* " : "  ";
  const truncatedModelId = truncateAutocompleteLabel(
    modelId,
    MODEL_LABEL_MAX_WIDTH
  );
  return `${currentMarker}${truncatedModelId}`;
};

const buildCurrentIndicatorLabel = (
  label: string,
  isCurrent: boolean
): string => {
  const currentMarker = isCurrent ? "* " : "  ";
  return `${currentMarker}${label}`;
};

const createAutocompleteCommands = (
  skills: SkillInfo[]
): SlashAutocompleteEntry[] => {
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

  const commandSuggestions = Array.from(getCommands().values()).map(
    (command) => {
      const aliases =
        "aliases" in command && Array.isArray(command.aliases)
          ? command.aliases
          : [];
      const aliasSuffix =
        aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";

      return createCommandSuggestion(
        command,
        command.name,
        `${command.description}${aliasSuffix}`
      );
    }
  );

  const skillSuggestions: AutocompleteItem[] = skills.map((skill) => {
    const commandName = toPromptsCommandName(skill.id);
    return {
      value: commandName,
      label: truncateAutocompleteLabel(commandName, SKILL_LABEL_MAX_WIDTH),
      description: skill.description,
    };
  });

  const suggestions: SlashAutocompleteEntry[] = [
    ...commandSuggestions,
    ...skillSuggestions,
  ];
  const seenNames = new Set<string>();
  const uniqueSuggestions: SlashAutocompleteEntry[] = [];

  for (const suggestion of suggestions) {
    const normalizedName = toAutocompleteEntryValue(suggestion).toLowerCase();
    if (seenNames.has(normalizedName)) {
      continue;
    }

    seenNames.add(normalizedName);
    uniqueSuggestions.push(suggestion);
  }

  return uniqueSuggestions;
};

const toAutocompleteItem = (suggestion: SlashCommand): AutocompleteItem => ({
  value: suggestion.name,
  label: suggestion.name,
  ...(suggestion.description ? { description: suggestion.description } : {}),
});

const buildCommandSuggestionsByName = (
  slashCommands: SlashAutocompleteEntry[]
): Map<string, SlashCommand> => {
  const commandSuggestionsByName = new Map<string, SlashCommand>();

  for (const suggestion of slashCommands) {
    if (!("name" in suggestion)) {
      continue;
    }

    commandSuggestionsByName.set(suggestion.name.toLowerCase(), suggestion);
  }

  return commandSuggestionsByName;
};

const buildAliasToCanonicalNameMap = (): Map<string, string> => {
  const aliasToCanonicalName = new Map<string, string>();

  for (const command of getCommands().values()) {
    const canonicalName = command.name.toLowerCase();

    for (const alias of command.aliases ?? []) {
      const normalizedAlias = alias.toLowerCase();
      if (normalizedAlias === canonicalName) {
        continue;
      }

      aliasToCanonicalName.set(normalizedAlias, canonicalName);
    }
  }

  return aliasToCanonicalName;
};

const getAliasArgumentSuggestions = (
  textBeforeCursor: string,
  commandSuggestionsByName: Map<string, SlashCommand>
): { items: AutocompleteItem[]; prefix: string } | null => {
  const spaceIndex = textBeforeCursor.indexOf(" ");
  if (spaceIndex < 0) {
    return null;
  }

  const commandName = textBeforeCursor.slice(1, spaceIndex).toLowerCase();
  const resolvedName = resolveRegisteredCommandName(commandName);
  if (resolvedName === commandName) {
    return null;
  }

  const command = commandSuggestionsByName.get(resolvedName);
  if (!command?.getArgumentCompletions) {
    return null;
  }

  const argumentPrefix = textBeforeCursor.slice(spaceIndex + 1);
  const items = command.getArgumentCompletions(argumentPrefix);
  if (!items || items.length === 0) {
    return null;
  }

  return {
    items,
    prefix: argumentPrefix,
  };
};

const getAliasMatches = (
  query: string,
  aliasToCanonicalName: Map<string, string>,
  commandSuggestionsByName: Map<string, SlashCommand>
): AutocompleteItem[] => {
  const aliasMatches: AutocompleteItem[] = [];
  const seenCanonicalNames = new Set<string>();

  for (const [alias, canonicalName] of aliasToCanonicalName) {
    if (!alias.startsWith(query) || seenCanonicalNames.has(canonicalName)) {
      continue;
    }

    const suggestion = commandSuggestionsByName.get(canonicalName);
    if (!suggestion) {
      continue;
    }

    seenCanonicalNames.add(canonicalName);
    aliasMatches.push(toAutocompleteItem(suggestion));
  }

  return aliasMatches;
};

const mergeAutocompleteItems = (
  prioritizedItems: AutocompleteItem[],
  fallbackItems: AutocompleteItem[] = []
): AutocompleteItem[] => {
  const mergedItems: AutocompleteItem[] = [];
  const seenValues = new Set<string>();

  for (const item of [...prioritizedItems, ...fallbackItems]) {
    const normalizedValue = item.value.toLowerCase();
    if (seenValues.has(normalizedValue)) {
      continue;
    }

    seenValues.add(normalizedValue);
    mergedItems.push(item);
  }

  return mergedItems;
};

const createAliasAwareAutocompleteProvider = (
  skills: SkillInfo[]
): AutocompleteProvider => {
  const slashCommands = createAutocompleteCommands(skills);
  const fallbackProvider = new CombinedAutocompleteProvider(
    slashCommands,
    process.cwd()
  );
  const commandSuggestionsByName = buildCommandSuggestionsByName(slashCommands);
  const aliasToCanonicalName = buildAliasToCanonicalNameMap();

  return {
    getSuggestions: (lines, cursorLine, cursorCol) => {
      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);

      if (!textBeforeCursor.startsWith("/")) {
        return fallbackProvider.getSuggestions(lines, cursorLine, cursorCol);
      }

      const aliasArgumentSuggestions = getAliasArgumentSuggestions(
        textBeforeCursor,
        commandSuggestionsByName
      );
      if (aliasArgumentSuggestions) {
        return aliasArgumentSuggestions;
      }

      const defaultSuggestions = fallbackProvider.getSuggestions(
        lines,
        cursorLine,
        cursorCol
      );

      if (textBeforeCursor.includes(" ")) {
        return defaultSuggestions;
      }

      const query = textBeforeCursor.slice(1).toLowerCase();
      if (query.length === 0) {
        return defaultSuggestions;
      }

      const aliasMatches = getAliasMatches(
        query,
        aliasToCanonicalName,
        commandSuggestionsByName
      );

      if (aliasMatches.length === 0) {
        return defaultSuggestions;
      }

      return {
        items: mergeAutocompleteItems(aliasMatches, defaultSuggestions?.items),
        prefix: textBeforeCursor,
      };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      fallbackProvider.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix
      ),
  };
};

interface CliUi {
  chatContainer: Container;
  clearStatus: () => void;
  dispose: () => void;
  editor: Editor;
  markdownTheme: MarkdownTheme;
  requestExit: () => void;
  showCommandLoader: (message: string) => void;
  showLoader: (message: string) => void;
  showModelSelector: (
    models: ModelInfo[],
    currentModelId: string,
    currentProvider: ProviderType,
    initialFilter?: string
  ) => Promise<ModelInfo | null>;
  showReasoningModeSelector: (
    currentMode: ReasoningMode
  ) => Promise<ReasoningMode | null>;
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
      "Enter to submit, Shift+Enter for newline, /help for commands, Ctrl+C clears input, Ctrl+C again exits"
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
  editor.setAutocompleteProvider(createAliasAwareAutocompleteProvider(skills));

  editorContainer.addChild(editor);

  tui.addChild(headerContainer);
  tui.addChild(chatContainer);
  tui.addChild(statusContainer);
  tui.addChild(editorContainer);
  tui.setFocus(editor);

  let loader: Loader | null = null;
  let commandLoaderInterval: Timer | null = null;
  let commandLoaderText: Text | null = null;
  let inputResolver: ((value: string | null) => void) | null = null;
  let pendingExitConfirmation = false;
  let lastCtrlCPressAt = 0;
  let activeModalCancel: (() => void) | null = null;

  const COMMAND_LOADER_FRAMES = ["-", "\\", "|", "/"] as const;

  const stopCommandLoader = (): void => {
    if (commandLoaderInterval) {
      clearInterval(commandLoaderInterval);
      commandLoaderInterval = null;
    }

    if (commandLoaderText) {
      statusContainer.removeChild(commandLoaderText);
      commandLoaderText = null;
    }
  };

  const clearStatus = (): void => {
    stopCommandLoader();
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

  const showCommandLoader = (message: string): void => {
    clearStatus();

    commandLoaderText = new Text("", 1, 0);
    statusContainer.addChild(commandLoaderText);

    let frameIndex = 0;
    const updateFrame = (): void => {
      const frame = COMMAND_LOADER_FRAMES[frameIndex];
      frameIndex = (frameIndex + 1) % COMMAND_LOADER_FRAMES.length;
      commandLoaderText?.setText(
        `${style(ANSI_CYAN, frame)} ${style(ANSI_DIM, message)}`
      );
      tui.requestRender();
    };

    updateFrame();
    commandLoaderInterval = setInterval(updateFrame, 80);
    tui.requestRender();
  };

  const clearPromptInput = (): void => {
    editor.setText("");
    tui.setFocus(editor);
    tui.requestRender();
  };

  const clearPendingExitConfirmation = (): void => {
    pendingExitConfirmation = false;
  };

  const setActiveModalCancel = (cancel: (() => void) | null): void => {
    activeModalCancel = cancel;
  };

  const dismissActiveModal = (): void => {
    if (!activeModalCancel) {
      return;
    }

    const cancel = activeModalCancel;
    activeModalCancel = null;
    cancel();
  };

  const shouldClearPendingExitConfirmation = (data: string): boolean => {
    if (!pendingExitConfirmation) {
      return false;
    }

    if (isCtrlCInput(data)) {
      return false;
    }

    if (isKeyRelease(data) || isKeyRepeat(data)) {
      return false;
    }

    return true;
  };

  const isCtrlCInput = (data: string): boolean => {
    return data === CTRL_C_ETX || matchesKey(data, Key.ctrl("c"));
  };

  const handleCtrlCPress = (): void => {
    const now = Date.now();

    // Double press within window: force exit immediately (upstream pattern)
    if (now - lastCtrlCPressAt < CTRL_C_EXIT_WINDOW_MS) {
      lastCtrlCPressAt = 0;
      dismissActiveModal();
      exitWithCleanup(0);
      return;
    }

    lastCtrlCPressAt = now;
    // First press: try to cancel active stream
    const canceled = cancelActiveStream();
    if (canceled) {
      pendingExitConfirmation = true;
      clearStatus();
      return;
    }

    // First press, no active stream: clear prompt
    pendingExitConfirmation = true;
    dismissActiveModal();
    clearPromptInput();
  };

  const showReasoningModeSelector = async (
    currentMode: ReasoningMode
  ): Promise<ReasoningMode | null> => {
    clearStatus();

    const selectableModes = agentManager.getSelectableReasoningModes();
    const descriptions: Record<ReasoningMode, string> = {
      off: "Disable reasoning mode",
      on: "Enable reasoning if supported",
      interleaved: "Enable interleaved reasoning field mode",
      preserved: "Enable preserved interleaved reasoning mode",
    };

    const selectorContainer = new Container();
    selectorContainer.addChild(
      new Text(style(ANSI_DIM, "Select reasoning execution"), 1, 0)
    );
    selectorContainer.addChild(new Spacer(1));

    const selectList = new SelectList(
      selectableModes.map((mode) => ({
        value: mode,
        label: buildCurrentIndicatorLabel(mode, currentMode === mode),
        description: descriptions[mode],
      })),
      2,
      editorTheme.selectList
    );

    const selectedIndex = selectableModes.indexOf(currentMode);
    selectList.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);

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

      const finish = (value: ReasoningMode | null): void => {
        if (done) {
          return;
        }
        done = true;
        setActiveModalCancel(null);
        cleanup();
        resolve(value);
      };

      setActiveModalCancel(() => {
        finish(null);
      });

      selectList.onSelect = (item) => {
        const selectedMode = parseReasoningMode(item.value);
        finish(selectedMode ?? DEFAULT_REASONING_MODE);
      };
      selectList.onCancel = () => {
        finish(null);
      };

      removeSelectorInputListener = tui.addInputListener((data) => {
        if (isCtrlCInput(data)) {
          handleCtrlCPress();
          finish(null);
          return { consume: true };
        }

        if (shouldClearPendingExitConfirmation(data)) {
          clearPendingExitConfirmation();
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
          label: buildCurrentIndicatorLabel(
            "disable",
            currentMode === "disable"
          ),
          description: "Use native tool support only",
        },
        {
          value: "morphxml",
          label: buildCurrentIndicatorLabel(
            "morphxml",
            currentMode === "morphxml"
          ),
          description: "XML tags per tool (MorphXML protocol)",
        },
        {
          value: "hermes",
          label: buildCurrentIndicatorLabel("hermes", currentMode === "hermes"),
          description: "Hermes JSON-in-XML tool_call format",
        },
        {
          value: "qwen3coder",
          label: buildCurrentIndicatorLabel(
            "qwen3coder",
            currentMode === "qwen3coder"
          ),
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
        setActiveModalCancel(null);
        cleanup();
        resolve(value);
      };

      setActiveModalCancel(() => {
        finish(null);
      });

      selectList.onSelect = (item) => {
        const parsedMode = parseToolFallbackMode(item.value);
        finish(parsedMode);
      };
      selectList.onCancel = () => {
        finish(null);
      };

      removeSelectorInputListener = tui.addInputListener((data) => {
        if (isCtrlCInput(data)) {
          handleCtrlCPress();
          finish(null);
          return { consume: true };
        }

        if (shouldClearPendingExitConfirmation(data)) {
          clearPendingExitConfirmation();
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
      const isCurrent =
        model.id === currentModelId && model.provider === currentProvider;

      return {
        value: key,
        label: buildModelSelectorLabel(model.id, isCurrent),
        description: buildModelSelectorDescription(model.name, providerLabel),
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
        setActiveModalCancel(null);
        cleanup();
        resolve(value);
      };

      setActiveModalCancel(() => {
        finish(null);
      });

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
        if (isCtrlCInput(data)) {
          handleCtrlCPress();
          finish(null);
          return { consume: true };
        }

        if (shouldClearPendingExitConfirmation(data)) {
          clearPendingExitConfirmation();
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
    pendingExitConfirmation = false;
    shouldExit = true;
    lastCtrlCPressAt = 0;
    dismissActiveModal();
    if (inputResolver) {
      const resolve = inputResolver;
      inputResolver = null;
      resolve(null);
    } else {
      exitWithCleanup(0);
    }
  };

  const onSigInt = () => {
    handleCtrlCPress();
  };

  const onTerminalResize = () => {
    tui.requestRender(true);
  };

  const removeInputListener = tui.addInputListener((data) => {
    if (isCtrlCInput(data)) {
      handleCtrlCPress();
      return { consume: true };
    }

    if (shouldClearPendingExitConfirmation(data)) {
      clearPendingExitConfirmation();
    }

    return undefined;
  });

  process.on("SIGINT", onSigInt);
  process.stdout.on("resize", onTerminalResize);

  editor.onSubmit = (text: string) => {
    if (!inputResolver) {
      return;
    }

    pendingExitConfirmation = false;
    lastCtrlCPressAt = 0;
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
    showCommandLoader,
    showLoader,
    showModelSelector,
    showToolFallbackSelector,
    showReasoningModeSelector,
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
    reasoningMode: agentManager.getReasoningMode(),
    toolFallbackMode: agentManager.getToolFallbackMode(),
  }))
);
registerCommand(createModelCommand());
registerCommand(createClearCommand());
registerCommand(createReasoningModeCommand());
registerCommand(createToolFallbackCommand());
registerCommand(createTranslateCommand());

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
    const candidate = args[index + 1];
    if (!candidate || candidate.startsWith("--")) {
      return {
        consumedArgs: 0,
        mode: DEFAULT_TOOL_FALLBACK_MODE,
      };
    }
    const parsedMode = parseToolFallbackMode(candidate);
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

const parseReasoningCliOption = (
  args: string[],
  index: number
): { consumedArgs: number; mode: ReasoningMode } | null => {
  const arg = args[index];
  if (arg === "--think") {
    return { consumedArgs: 0, mode: "on" };
  }

  if (arg !== "--reasoning-mode") {
    return null;
  }

  const candidate = args[index + 1];
  if (candidate && !candidate.startsWith("--")) {
    const parsedMode = parseReasoningMode(candidate);
    return {
      consumedArgs: 1,
      mode: parsedMode ?? DEFAULT_REASONING_MODE,
    };
  }

  return {
    consumedArgs: 0,
    mode: DEFAULT_REASONING_MODE,
  };
};

const parseTranslateCliOption = (arg: string): boolean | null => {
  if (arg === "--translate") {
    return true;
  }
  if (arg === "--no-translate") {
    return false;
  }
  return null;
};

const parseCliArgs = (): {
  reasoningMode: ReasoningMode | null;
  toolFallbackMode: ToolFallbackMode;
  model: string | null;
  provider: ProviderType | null;
  translateUserPrompts: boolean;
} => {
  const args = process.argv.slice(2);
  let reasoningMode: ReasoningMode | null = null;
  let toolFallbackMode: ToolFallbackMode = DEFAULT_TOOL_FALLBACK_MODE;
  let model: string | null = null;
  let provider: ProviderType | null = null;
  let translateUserPrompts = true;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    const reasoningOption = parseReasoningCliOption(args, i);
    if (reasoningOption) {
      reasoningMode = reasoningOption.mode;
      i += reasoningOption.consumedArgs;
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
      continue;
    }

    const translateOption = parseTranslateCliOption(arg);
    if (translateOption !== null) {
      translateUserPrompts = translateOption;
    }
  }

  return {
    reasoningMode,
    toolFallbackMode,
    model,
    provider,
    translateUserPrompts,
  };
};

const setupAgent = (): void => {
  const {
    reasoningMode,
    toolFallbackMode,
    model,
    provider,
    translateUserPrompts,
  } = parseCliArgs();
  if (provider) {
    agentManager.setProvider(provider);
  }
  if (model) {
    agentManager.setModelId(model);
  }

  if (reasoningMode !== null) {
    agentManager.setReasoningMode(reasoningMode);
  }

  agentManager.setToolFallbackMode(toolFallbackMode);
  agentManager.setTranslationEnabled(translateUserPrompts);
};

type AgentResponseStatus = "completed" | "interrupted";

const processAgentResponse = async (
  ui: CliUi
): Promise<AgentResponseStatus> => {
  let manualToolLoopCount = 0;

  while (true) {
    ui.showLoader("Working...");
    const streamAbortController = new AbortController();
    activeStreamController = streamAbortController;
    streamInterruptRequested = false;

    try {
      const stream = await agentManager.stream(
        messageHistory.toModelMessages(),
        { abortSignal: streamAbortController.signal }
      );

      let hasClearedStreamingLoader = false;
      const clearStreamingLoader = (): void => {
        if (hasClearedStreamingLoader) {
          return;
        }
        hasClearedStreamingLoader = true;
        ui.clearStatus();
      };

      await renderFullStreamWithPiTui(stream.fullStream, {
        ui: ui.tui,
        chatContainer: ui.chatContainer,
        markdownTheme: ui.markdownTheme,
        onFirstVisiblePart: clearStreamingLoader,
        showReasoning: true,
        showSteps: false,
        showToolResults: true,
        showFiles: false,
        showSources: false,
        showFinishReason: env.DEBUG_SHOW_FINISH_REASON,
      });

      clearStreamingLoader();

      const [response, finishReason] = await Promise.all([
        stream.response,
        stream.finishReason,
      ]);

      if (streamInterruptRequested || streamAbortController.signal.aborted) {
        addSystemMessage(
          ui.chatContainer,
          "[agent] Stream interrupted by user. Waiting for input."
        );
        ui.tui.requestRender();
        return "interrupted";
      }

      messageHistory.addModelMessages(response.messages);

      if (!shouldContinueManualToolLoop(finishReason)) {
        return "completed";
      }

      manualToolLoopCount += 1;
      if (manualToolLoopCount >= MANUAL_TOOL_LOOP_MAX_STEPS) {
        addSystemMessage(
          ui.chatContainer,
          `[agent] Manual tool loop safety cap reached (${MANUAL_TOOL_LOOP_MAX_STEPS}); waiting for input.`
        );
        ui.tui.requestRender();
        return "completed";
      }
    } catch (error) {
      if (streamInterruptRequested || streamAbortController.signal.aborted) {
        addSystemMessage(
          ui.chatContainer,
          "[agent] Stream interrupted by user. Waiting for input."
        );
        ui.tui.requestRender();
        return "interrupted";
      }

      throw error;
    } finally {
      clearActiveStreamController(streamAbortController);
      streamInterruptRequested = false;
      ui.clearStatus();
    }
  }
};

const handleAgentResponse = async (ui: CliUi): Promise<void> => {
  while (true) {
    const result = await processAgentResponse(ui);
    if (result === "interrupted") {
      return;
    }

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

const resolveReasoningModeCommandInput = async (
  ui: CliUi,
  commandInput: string,
  parsed: ReturnType<typeof parseCommand>
): Promise<string | null> => {
  if (
    !parsed ||
    (parsed.name !== "think" && parsed.name !== "reasoning-mode") ||
    parsed.args.length > 0
  ) {
    return commandInput;
  }

  const selected = await ui.showReasoningModeSelector(
    agentManager.getReasoningMode()
  );
  if (!selected) {
    return null;
  }

  return `/reasoning-mode ${selected}`;
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

  const reasoningModeCommandInput = await resolveReasoningModeCommandInput(
    ui,
    commandInput,
    initialParsed
  );
  if (!reasoningModeCommandInput) {
    return true;
  }
  commandInput = reasoningModeCommandInput;

  const parsed = parseCommand(commandInput);
  const resolvedCommandName = parsed
    ? resolveRegisteredCommandName(parsed.name)
    : null;
  const isNativeCommand =
    resolvedCommandName === "clear" ||
    resolvedCommandName === "reasoning-mode" ||
    resolvedCommandName === "tool-fallback";

  if (!isNativeCommand) {
    ui.showCommandLoader("Running command...");
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

    let contentForModel = trimmed;
    let originalContent: string | undefined;
    let translationError: string | undefined;

    if (agentManager.isTranslationEnabled()) {
      const shouldShowTranslationLoader = isNonEnglish(trimmed);
      if (shouldShowTranslationLoader) {
        addUserMessage(ui.chatContainer, ui.markdownTheme, trimmed);
        ui.tui.requestRender();
      }

      if (shouldShowTranslationLoader) {
        ui.showLoader("Translating...");
      }

      try {
        const translationResult = await translateToEnglish(
          trimmed,
          agentManager
        );
        contentForModel = translationResult.text;
        originalContent = translationResult.originalText;
        translationError = translationResult.error;
      } finally {
        if (shouldShowTranslationLoader) {
          ui.clearStatus();
        }
      }
    }

    if (!(isNonEnglish(trimmed) && agentManager.isTranslationEnabled())) {
      addUserMessage(ui.chatContainer, ui.markdownTheme, contentForModel);
    } else if (originalContent) {
      addTranslatedMessage(ui.chatContainer, ui.markdownTheme, contentForModel);
    }

    if (translationError) {
      addSystemMessage(
        ui.chatContainer,
        `[translation] Failed to translate input: ${translationError}. Using original text.`
      );
    }
    messageHistory.addUserMessage(contentForModel, originalContent);
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
    cleanupExecutionResources();
    setSpinnerOutputEnabled(true);
  }
};

const cleanupExecutionResources = (): void => {
  cleanup();
};

const exitWithCleanup = (code: number): never => {
  cleanupExecutionResources();
  process.exit(code);
};

process.once("exit", () => {
  cleanupExecutionResources();
});

process.once("SIGTERM", () => {
  exitWithCleanup(143);
});

process.once("SIGHUP", () => {
  exitWithCleanup(129);
});

process.once("SIGQUIT", () => {
  exitWithCleanup(131);
});

process.once("uncaughtException", (error: unknown) => {
  console.error("Fatal error:", error);
  exitWithCleanup(1);
});

process.once("unhandledRejection", (reason: unknown) => {
  console.error("Unhandled rejection:", reason);
  exitWithCleanup(1);
});

run().catch((error: unknown) => {
  console.error("Fatal error:", error);
  exitWithCleanup(1);
});
