import {
  type AgentStreamResult,
  type Command,
  type CommandResult,
  executeCommand,
  getCommands,
  isCommand,
  type MessageHistory,
  parseCommand,
  type SkillInfo,
  shouldContinueManualToolLoop,
} from "@ai-sdk-tool/harness";
import {
  Container,
  Editor,
  type EditorTheme,
  isKeyRelease,
  isKeyRepeat,
  Key,
  Loader,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import { createAliasAwareAutocompleteProvider } from "./autocomplete";
import {
  addChatComponent,
  createInfoMessage,
  IGNORE_PART_TYPES,
  isVisibleStreamPart,
  type PiTuiRenderFlags,
  type PiTuiStreamState,
  STREAM_HANDLERS,
  type ToolInputRenderState,
} from "./stream-handlers";
import { AssistantStreamView } from "./stream-views";
import { BaseToolCallView, type ToolRendererMap } from "./tool-call-view";

const ANSI_RESET = "\x1b[0m";
const ANSI_BLACK = "\x1b[30m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_BG_SOFT_LIGHT = "\x1b[48;5;249m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_BRIGHT_CYAN = "\x1b[96m";
const ANSI_GRAY = "\x1b[90m";
const CTRL_C_ETX = "\u0003";
const CTRL_C_EXIT_WINDOW_MS = 500;

const style = (prefix: string, text: string): string => {
  return `${prefix}${text}${ANSI_RESET}`;
};

const createDefaultMarkdownTheme = (): MarkdownTheme => {
  return {
    heading: (text) => style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, text),
    link: (text) => style(`${ANSI_BOLD}${ANSI_CYAN}`, text),
    linkUrl: (text) => style(ANSI_GRAY, text),
    code: (text) => style(ANSI_CYAN, text),
    codeBlock: (text) => style(ANSI_CYAN, text),
    codeBlockBorder: (text) => style(ANSI_GRAY, text),
    quote: (text) => style(ANSI_GRAY, text),
    quoteBorder: (text) => style(ANSI_GRAY, text),
    hr: (text) => style(ANSI_GRAY, text),
    listBullet: (text) => style(ANSI_CYAN, text),
    bold: (text) => style(ANSI_BOLD, text),
    italic: (text) => style(ANSI_DIM, text),
    strikethrough: (text) => style(ANSI_DIM, text),
    underline: (text) => style(ANSI_BOLD, text),
    codeBlockIndent: "  ",
  };
};

const createDefaultEditorTheme = (): EditorTheme => {
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
  addChatComponent(
    chatContainer,
    new Markdown(message, 1, 1, markdownTheme, {
      bgColor: (text: string) =>
        style(`${ANSI_BG_SOFT_LIGHT}${ANSI_BLACK}`, text),
    })
  );
};

const addSystemMessage = (chatContainer: Container, message: string): void => {
  const cleaned = message.trimEnd();
  if (cleaned.length === 0) {
    return;
  }

  addChatComponent(chatContainer, new Text(style(ANSI_GRAY, cleaned), 1, 0));
};

const addNewSessionMessage = (chatContainer: Container): void => {
  addChatComponent(
    chatContainer,
    new Text(style(ANSI_BRIGHT_CYAN, "✓ New session started"), 1, 1)
  );
};

export interface AgentTUIConfig {
  agent: {
    stream: (messages: unknown[], opts?: unknown) => Promise<AgentStreamResult>;
  };
  commands?: Command[];
  header?: { title: string; subtitle?: string };
  messageHistory: MessageHistory;
  onSetup?: () => void | Promise<void>;
  skills?: SkillInfo[];
  theme?: { markdownTheme?: MarkdownTheme; editorTheme?: EditorTheme };
  toolRenderers?: ToolRendererMap;
}

export async function createAgentTUI(config: AgentTUIConfig): Promise<void> {
  const markdownTheme =
    config.theme?.markdownTheme ?? createDefaultMarkdownTheme();
  const editorTheme = config.theme?.editorTheme ?? createDefaultEditorTheme();
  const skills = config.skills ?? [];
  const commands = config.commands ?? Array.from(getCommands().values());
  const commandLookup = new Map<string, Command>();
  const commandAliasLookup = new Map<string, string>();

  for (const command of commands) {
    const normalizedName = command.name.toLowerCase();
    commandLookup.set(normalizedName, command);
    for (const alias of command.aliases ?? []) {
      const normalizedAlias = alias.toLowerCase();
      if (normalizedAlias !== normalizedName) {
        commandAliasLookup.set(normalizedAlias, normalizedName);
      }
    }
  }

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  tui.setClearOnShrink(true);

  const headerContainer = new Container();
  const chatContainer = new Container();
  const statusContainer = new Container();
  const editorContainer = new Container();

  const title = new Text("", 1, 0);
  const help = new Text(
    style(
      ANSI_DIM,
      "Enter to submit, Shift+Enter for newline, /help for commands, Ctrl+C to clear, Ctrl+C twice to exit"
    ),
    1,
    0
  );

  const updateHeader = (): void => {
    const headerTitle = config.header?.title ?? "Agent TUI";
    const subtitle = config.header?.subtitle;
    title.setText(
      subtitle
        ? `${style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, headerTitle)}\n${style(ANSI_DIM, subtitle)}`
        : style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, headerTitle)
    );
    tui.requestRender();
  };

  headerContainer.addChild(new Spacer(1));
  headerContainer.addChild(title);
  headerContainer.addChild(help);
  headerContainer.addChild(new Spacer(1));

  const editor = new Editor(tui, editorTheme, {
    paddingX: 1,
    autocompleteMaxVisible: 8,
  });
  editor.setAutocompleteProvider(
    createAliasAwareAutocompleteProvider(skills, {
      commands,
      basePath: process.cwd(),
    })
  );
  editorContainer.addChild(editor);

  tui.addChild(headerContainer);
  tui.addChild(chatContainer);
  tui.addChild(statusContainer);
  tui.addChild(editorContainer);
  tui.setFocus(editor);

  let shouldExit = false;
  let activeStreamController: AbortController | null = null;
  let streamInterruptRequested = false;
  let inputResolver: null | ((value: string | null) => void) = null;
  let lastCtrlCPressAt = 0;
  let loader: Loader | null = null;

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

  const clearPromptInput = (): void => {
    editor.setText("");
    tui.setFocus(editor);
    tui.requestRender();
  };

  const cancelActiveStream = (): boolean => {
    if (!activeStreamController || activeStreamController.signal.aborted) {
      return false;
    }

    streamInterruptRequested = true;
    activeStreamController.abort("User requested stream interruption");
    return true;
  };

  const requestExit = (): void => {
    shouldExit = true;
    cancelActiveStream();
    clearStatus();
    if (inputResolver) {
      const resolve = inputResolver;
      inputResolver = null;
      resolve(null);
    }
  };

  const isCtrlCInput = (data: string): boolean => {
    if (isKeyRelease(data) || isKeyRepeat(data)) {
      return false;
    }

    return data === CTRL_C_ETX || matchesKey(data, Key.ctrl("c"));
  };

  const handleCtrlCPress = (): void => {
    const now = Date.now();
    if (now - lastCtrlCPressAt < CTRL_C_EXIT_WINDOW_MS) {
      requestExit();
      return;
    }

    cancelActiveStream();
    clearPromptInput();
    lastCtrlCPressAt = now;
  };

  const onTerminalResize = (): void => {
    tui.requestRender(true);
  };

  const removeInputListener = tui.addInputListener((data) => {
    if (isCtrlCInput(data)) {
      handleCtrlCPress();
      return { consume: true };
    }
    return undefined;
  });

  const onSigInt = (): void => {
    handleCtrlCPress();
  };

  process.on("SIGINT", onSigInt);
  process.stdout.on("resize", onTerminalResize);

  editor.onSubmit = (text: string) => {
    if (!inputResolver) {
      return;
    }

    const trimmed = text.trim();
    if (trimmed.length > 0) {
      editor.addToHistory(trimmed);
    }

    const resolve = inputResolver;
    inputResolver = null;
    resolve(text);
  };

  const waitForInput = (): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      inputResolver = (value: string | null) => resolve(value);
      tui.setFocus(editor);
      tui.requestRender();
    });
  };

  const renderAgentStream = async (
    stream: AsyncIterable<unknown>,
    flags: PiTuiRenderFlags,
    onFirstVisiblePart?: () => void
  ): Promise<void> => {
    const activeToolInputs = new Map<string, ToolInputRenderState>();
    const streamedToolCallIds = new Set<string>();
    const toolViews = new Map<string, BaseToolCallView>();
    let assistantView: AssistantStreamView | null = null;
    let suppressAssistantLeadingSpacer = false;
    let firstVisiblePartSeen = false;

    const resetAssistantView = (suppressLeadingSpacer = false): void => {
      if (suppressLeadingSpacer) {
        suppressAssistantLeadingSpacer = true;
      }
      assistantView = null;
    };

    const ensureAssistantView = (): AssistantStreamView => {
      if (!assistantView) {
        assistantView = new AssistantStreamView(markdownTheme);
        addChatComponent(chatContainer, assistantView, {
          addLeadingSpacer: !suppressAssistantLeadingSpacer,
        });
        suppressAssistantLeadingSpacer = false;
      }

      return assistantView;
    };

    const ensureToolView = (
      toolCallId: string,
      toolName: string
    ): BaseToolCallView => {
      const existing = toolViews.get(toolCallId);
      if (existing) {
        existing.setToolName(toolName);
        return existing;
      }

      const view = new BaseToolCallView(
        toolCallId,
        toolName,
        markdownTheme,
        () => tui.requestRender(),
        flags.showRawToolIo,
        config.toolRenderers
      );
      toolViews.set(toolCallId, view);
      addChatComponent(chatContainer, view);
      return view;
    };

    const state: PiTuiStreamState = {
      flags,
      activeToolInputs,
      streamedToolCallIds,
      resetAssistantView,
      ensureAssistantView,
      ensureToolView,
      getToolView: (toolCallId: string) => toolViews.get(toolCallId),
      chatContainer,
    };

    try {
      for await (const rawPart of stream) {
        const part = rawPart as {
          type: string;
        };

        if (
          !firstVisiblePartSeen &&
          isVisibleStreamPart(part as never, flags)
        ) {
          firstVisiblePartSeen = true;
          onFirstVisiblePart?.();
        }

        const handler = STREAM_HANDLERS[part.type];
        if (handler) {
          await handler(part as never, state);
        } else if (!IGNORE_PART_TYPES.has(part.type)) {
          state.resetAssistantView();
          addChatComponent(
            state.chatContainer,
            createInfoMessage("[unknown part]", part)
          );
        }

        tui.requestRender();
      }
    } finally {
      for (const view of toolViews.values()) {
        view.dispose();
      }
    }
  };

  const runSingleStreamTurn = async (): Promise<
    "completed" | "continue" | "interrupted"
  > => {
    showLoader("Working...");
    const streamAbortController = new AbortController();
    activeStreamController = streamAbortController;
    streamInterruptRequested = false;

    try {
      const stream = await config.agent.stream(
        config.messageHistory.toModelMessages(),
        {
          abortSignal: streamAbortController.signal,
        }
      );

      let hasClearedStreamingLoader = false;
      const clearStreamingLoader = (): void => {
        if (hasClearedStreamingLoader) {
          return;
        }
        hasClearedStreamingLoader = true;
        clearStatus();
      };

      await renderAgentStream(
        stream.fullStream as AsyncIterable<unknown>,
        {
          showReasoning: true,
          showSteps: false,
          showFinishReason: false,
          showRawToolIo: false,
          showToolResults: true,
          showSources: false,
          showFiles: false,
        },
        clearStreamingLoader
      );

      clearStreamingLoader();

      const [response, finishReason] = await Promise.all([
        stream.response,
        stream.finishReason,
      ]);

      if (streamInterruptRequested || streamAbortController.signal.aborted) {
        addSystemMessage(chatContainer, "[agent] Stream interrupted by user.");
        tui.requestRender();
        return "interrupted";
      }

      config.messageHistory.addModelMessages(response.messages);
      return shouldContinueManualToolLoop(finishReason)
        ? "continue"
        : "completed";
    } catch (error) {
      if (streamInterruptRequested || streamAbortController.signal.aborted) {
        addSystemMessage(chatContainer, "[agent] Stream interrupted by user.");
        tui.requestRender();
        return "interrupted";
      }

      throw error;
    } finally {
      if (activeStreamController === streamAbortController) {
        activeStreamController = null;
      }
      streamInterruptRequested = false;
      clearStatus();
    }
  };

  const processAgentResponse = async (): Promise<
    "completed" | "interrupted"
  > => {
    while (true) {
      const turnStatus = await runSingleStreamTurn();
      if (turnStatus === "continue") {
        continue;
      }
      return turnStatus;
    }
  };

  const executeLocalCommand = async (
    input: string
  ): Promise<CommandResult | null> => {
    const parsed = parseCommand(input);
    if (!parsed) {
      return null;
    }

    const normalizedName = parsed.name.toLowerCase();
    const resolvedName =
      commandAliasLookup.get(normalizedName) ?? normalizedName;
    const command = commandLookup.get(resolvedName);
    if (!command) {
      return null;
    }

    return await command.execute({ args: parsed.args });
  };

  const processInput = async (input: string): Promise<boolean> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return true;
    }

    try {
      editor.disableSubmit = true;

      if (isCommand(trimmed)) {
        const commandResult =
          (await executeLocalCommand(trimmed)) ??
          (await executeCommand(trimmed));

        if (commandResult?.message) {
          addSystemMessage(chatContainer, commandResult.message);
        }

        if (commandResult?.success && commandResult.action === "new-session") {
          config.messageHistory.clear();
          chatContainer.clear();
          addNewSessionMessage(chatContainer);
        }

        tui.requestRender();
        return true;
      }

      addUserMessage(chatContainer, markdownTheme, trimmed);
      config.messageHistory.addUserMessage(trimmed);
      tui.requestRender();

      await processAgentResponse();
      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      addSystemMessage(chatContainer, `Error: ${errorMessage}`);
      tui.requestRender();
      return true;
    } finally {
      editor.disableSubmit = false;
      editor.setText("");
      tui.setFocus(editor);
      tui.requestRender();
    }
  };

  updateHeader();
  tui.start();

  try {
    await config.onSetup?.();

    while (!shouldExit) {
      const input = await waitForInput();
      if (input === null) {
        break;
      }

      const shouldContinue = await processInput(input);
      if (!shouldContinue) {
        break;
      }
    }
  } finally {
    clearStatus();
    const pendingResolver: unknown = inputResolver;
    inputResolver = null;
    if (typeof pendingResolver === "function") {
      pendingResolver(null);
    }

    removeInputListener();
    process.stdout.off("resize", onTerminalResize);
    process.off("SIGINT", onSigInt);

    try {
      await terminal.drainInput();
    } finally {
      tui.stop();
    }
  }
}
