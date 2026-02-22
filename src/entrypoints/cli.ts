#!/usr/bin/env bun

import { stripVTControlCharacters } from "node:util";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  type EditorTheme,
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
} from "../commands";
import { createClearCommand } from "../commands/clear";
import { createModelCommand } from "../commands/model";
import { createNewCommand } from "../commands/new";
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
  buildTodoContinuationUserMessage,
  getIncompleteTodos,
} from "../middleware/todo-continuation";
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

const TODO_CONTINUATION_MAX_LOOPS = 5;

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
  const commandSuggestions = Array.from(getCommands().values()).map(
    (command) => {
      const suggestions = command.argumentSuggestions;

      return {
        name: command.name,
        description: command.description,
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
  showThinkSelector: (currentEnabled: boolean) => Promise<"on" | "off" | null>;
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
    toolFallbackEnabled: agentManager.isToolFallbackEnabled(),
  }))
);
registerCommand(createModelCommand());
registerCommand(createClearCommand());
registerCommand(createNewCommand());
registerCommand(createThinkCommand());
registerCommand(createToolFallbackCommand());

const parseCliArgs = (): {
  thinking: boolean;
  toolFallback: boolean;
  model: string | null;
  provider: ProviderType | null;
} => {
  const args = process.argv.slice(2);
  let thinking = false;
  let toolFallback = false;
  let model: string | null = null;
  let provider: ProviderType | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--think") {
      thinking = true;
      continue;
    }

    if (arg === "--tool-fallback") {
      toolFallback = true;
      continue;
    }

    if (arg === "--model" && i + 1 < args.length) {
      model = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--provider" && i + 1 < args.length) {
      const providerArg = args[i + 1];
      if (providerArg === "anthropic" || providerArg === "friendli") {
        provider = providerArg;
      }
      i += 1;
    }
  }

  return { thinking, toolFallback, model, provider };
};

const setupAgent = (): void => {
  const { thinking, toolFallback, model, provider } = parseCliArgs();
  agentManager.setThinkingEnabled(thinking);
  agentManager.setToolFallbackEnabled(toolFallback);
  if (provider) {
    agentManager.setProvider(provider);
  }
  if (model) {
    agentManager.setModelId(model);
  }
};

const processAgentResponse = async (ui: CliUi): Promise<void> => {
  ui.showLoader("Thinking...");
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

  const response = await stream.response;
  messageHistory.addModelMessages(response.messages);
};

const handleAgentResponse = async (ui: CliUi): Promise<void> => {
  let continuationCount = 0;

  while (continuationCount <= TODO_CONTINUATION_MAX_LOOPS) {
    await processAgentResponse(ui);

    const incompleteTodos = await getIncompleteTodos();
    if (incompleteTodos.length === 0) {
      return;
    }

    if (continuationCount === TODO_CONTINUATION_MAX_LOOPS) {
      addSystemMessage(
        ui.chatContainer,
        "[todo] Auto-continue limit reached; waiting for input."
      );
      ui.tui.requestRender();
      return;
    }

    const reminder = buildTodoContinuationUserMessage(incompleteTodos);
    messageHistory.addUserMessage(reminder);
    continuationCount += 1;
  }
};

const handleCommand = async (ui: CliUi, input: string): Promise<boolean> => {
  let commandInput = input;
  const initialParsed = parseCommand(commandInput);

  if (initialParsed?.name === "think" && initialParsed.args.length === 0) {
    const selected = await ui.showThinkSelector(
      agentManager.isThinkingEnabled()
    );
    if (!selected) {
      return true;
    }
    commandInput = `/think ${selected}`;
  }

  const parsed = parseCommand(commandInput);
  const isNativeCommand =
    parsed?.name === "clear" ||
    parsed?.name === "new" ||
    parsed?.name === "think";

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
    addSystemMessage(ui.chatContainer, result.message);
    ui.updateHeader();
    ui.tui.requestRender();
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
