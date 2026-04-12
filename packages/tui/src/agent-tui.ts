import {
  type CheckpointMessage,
  type Command,
  type CommandAction,
  type CommandResult,
  type CompactionCircuitBreaker,
  CompactionOrchestrator,
  type CompactionOrchestratorCallbacks,
  type CompactionResult,
  computeContextBudget,
  estimateTokens,
  executeCommand,
  harnessEnv,
  isCommand,
  AgentErrorCode,
  AgentError,
  isSkillCommandResult,
  type ModelMessage,
  normalizeUsageMeasurement,
  type OverflowRecoveryResult,
  parseCommand,
  type RunnableAgent,
  type SkillInfo,
  shouldContinueManualToolLoop,
  type UsageMeasurement,
} from "@ai-sdk-tool/harness";
import {
  Container,
  Editor,
  type EditorTheme,
  isKeyRelease,
  isKeyRepeat,
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { createAliasAwareAutocompleteProvider } from "./autocomplete";
import { buildTuiCommandSet } from "./command-set";
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
const ANSI_BG_GRAY = "\x1b[100m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_BRIGHT_CYAN = "\x1b[96m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_BRIGHT_YELLOW = "\x1b[93m";
const ANSI_RED = "\x1b[31m";
const CTRL_C_ETX = "\u0003";
const CTRL_C_EXIT_WINDOW_MS = 500;

const getConfiguredContextPressureLevel = (
  usedTokens: number,
  budget: ReturnType<typeof computeContextBudget>,
  thresholds: {
    critical: number;
    elevated: number;
    warning: number;
  }
): "critical" | "elevated" | "normal" | "warning" => {
  const hardLimit = Math.max(budget.hardLimitAt, 1);
  const ratio = usedTokens / hardLimit;

  if (ratio >= thresholds.critical) {
    return "critical";
  }
  if (ratio >= thresholds.warning) {
    return "warning";
  }
  if (ratio >= thresholds.elevated) {
    return "elevated";
  }

  return "normal";
};

interface ContextPressureThresholds {
  critical: number;
  elevated: number;
  warning: number;
}

const style = (prefix: string, text: string): string => {
  return `${prefix}${text}${ANSI_RESET}`;
};

class StatusSpinner extends Text {
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private currentFrame = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly tui: TUI;
  private readonly spinnerColorFn: (text: string) => string;
  private readonly messageColorFn: (text: string) => string;
  private message: string;

  constructor(
    tui: TUI,
    spinnerColorFn: (text: string) => string,
    messageColorFn: (text: string) => string,
    message: string
  ) {
    super("", 1, 0);
    this.tui = tui;
    this.spinnerColorFn = spinnerColorFn;
    this.messageColorFn = messageColorFn;
    this.message = message;
    this.start();
  }

  start(): void {
    this.updateDisplay();
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      this.updateDisplay();
    }, 80);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  setMessage(message: string): void {
    this.message = message;
    this.updateDisplay();
  }

  render(width: number): string[] {
    return ["", ...super.render(width)];
  }

  private updateDisplay(): void {
    const frame = this.frames[this.currentFrame];
    this.setText(
      `${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message)}`
    );
    this.tui.requestRender();
  }
}

const truncatePlainToWidth = (text: string, maxWidth: number): string => {
  if (maxWidth <= 0) {
    return "";
  }

  if (visibleWidth(text) <= maxWidth) {
    return text;
  }

  if (maxWidth === 1) {
    return "…";
  }

  let result = "";
  for (const char of text) {
    const candidate = `${result}${char}`;
    if (visibleWidth(candidate) >= maxWidth) {
      break;
    }
    result = candidate;
  }

  return `${result}…`;
};

interface FooterStatusEntry {
  level?: "error" | "info" | "warning";
  message: string;
  state: "ready" | "running";
}

class FooterStatusBar extends Text {
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private currentFrame = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private entries: FooterStatusEntry[] = [];
  private rightText: string | undefined;
  private rightTextPressure:
    | "critical"
    | "elevated"
    | "normal"
    | "warning"
    | undefined;
  private readonly tui: TUI;

  constructor(tui: TUI) {
    super("", 1, 0);
    this.tui = tui;
    this.start();
  }

  setEntries(entries: FooterStatusEntry[]): void {
    this.entries = [...entries];
    this.invalidate();
    this.tui.requestRender();
  }

  setRightText(
    text: string | undefined,
    pressure?: "critical" | "elevated" | "normal" | "warning"
  ): void {
    this.rightText = text?.trim() || undefined;
    this.rightTextPressure = pressure;
    this.invalidate();
    this.tui.requestRender();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  render(width: number): string[] {
    if (this.entries.length === 0 && !this.rightText) {
      return [];
    }

    const contentWidth = Math.max(1, width - 2);
    const lines: string[] = [];
    const rightTextPlain = this.rightText ?? "";
    const rightTextStyled = rightTextPlain
      ? style(
          this.resolvePressureStylePrefix(this.rightTextPressure),
          rightTextPlain
        )
      : "";

    const renderLeftEntry = (
      entry: FooterStatusEntry,
      maxWidth: number
    ): { plain: string; styled: string } => {
      const prefix =
        entry.state === "running" ? this.frames[this.currentFrame] : "";
      const prefixStyle =
        entry.state === "running" ? style(ANSI_CYAN, prefix) : "";
      const messageStylePrefix = this.resolveEntryStylePrefix(entry.level);
      const reservedPrefixWidth = prefix ? visibleWidth(prefix) + 1 : 0;
      const maxMessageWidth = Math.max(0, maxWidth - reservedPrefixWidth);
      const message = truncatePlainToWidth(entry.message, maxMessageWidth);

      return {
        plain: prefix ? `${prefix}${message ? ` ${message}` : ""}` : message,
        styled: prefix
          ? `${prefixStyle}${message ? ` ${style(messageStylePrefix, message)}` : ""}`
          : style(messageStylePrefix, message),
      };
    };

    const firstEntry = this.entries[0];
    if (firstEntry || rightTextStyled) {
      const maxLeftWidth = rightTextPlain
        ? Math.max(0, contentWidth - visibleWidth(rightTextPlain) - 1)
        : contentWidth;
      const left = firstEntry
        ? renderLeftEntry(firstEntry, maxLeftWidth)
        : null;
      const leftWidth = left ? visibleWidth(left.plain) : 0;
      const gap = rightTextPlain
        ? Math.max(1, contentWidth - leftWidth - visibleWidth(rightTextPlain))
        : 0;
      const line = `${" ".repeat(1)}${left?.styled ?? ""}${" ".repeat(gap)}${rightTextStyled}`;
      lines.push(line + " ".repeat(Math.max(0, width - visibleWidth(line))));
    }

    for (const entry of this.entries.slice(1)) {
      const left = renderLeftEntry(entry, contentWidth);
      const line = `${" ".repeat(1)}${left.styled}`;
      lines.push(line + " ".repeat(Math.max(0, width - visibleWidth(line))));
    }

    return lines;
  }

  private start(): void {
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      this.invalidate();
      this.tui.requestRender();
    }, 80);
  }

  private resolvePressureStylePrefix(
    pressure: "critical" | "elevated" | "normal" | "warning" | undefined
  ): string {
    if (pressure === "critical") {
      return `${ANSI_BOLD}${ANSI_RED}`;
    }
    if (pressure === "warning") {
      return `${ANSI_BOLD}${ANSI_BRIGHT_YELLOW}`;
    }
    if (pressure === "elevated") {
      return ANSI_YELLOW;
    }
    return ANSI_DIM;
  }

  private resolveEntryStylePrefix(
    level: "error" | "info" | "warning" | undefined
  ): string {
    if (level === "error") {
      return ANSI_RED;
    }
    if (level === "warning") {
      return ANSI_YELLOW;
    }
    return ANSI_DIM;
  }
}

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

export type PreprocessResult =
  | {
      success: true;
      message: string;
      translatedDisplay?: string;
    }
  | {
      success: false;
      error: string;
    };

export interface PreprocessHooks {
  clearStatus: () => void;
  showStatus: (text: string) => void;
}

export interface CommandPreprocessHooks {
  addInputListener: (
    listener: (data: string) => { consume: boolean; data?: string } | undefined
  ) => () => void;
  clearStatus: () => void;
  editorTheme: EditorTheme;
  handleCtrlCPress: () => void;
  isCtrlCInput: (data: string) => boolean;
  showMessage: (message: string) => void;
  statusContainer: Container;
  tui: TUI;
  updateHeader: () => void;
}

export interface MessageReadable {
  getAll(): CheckpointMessage[];
  getMessagesForLLM(): ModelMessage[];
  toModelMessages(): ModelMessage[];
}

export interface MessageWritable {
  addModelMessages(messages: ModelMessage[]): unknown;
  addUserMessage(content: string, originalContent?: string): unknown;
  clear(): void;
  reset?(): void;
}

export interface ContextAware {
  compact(options?: {
    aggressive?: boolean;
    auto?: boolean;
  }): Promise<boolean | CompactionResult>;
  getActualUsage(): { inputTokens?: number; totalTokens?: number } | null;
  getCompactionConfig(): {
    contextLimit?: number;
    enabled?: boolean;
    keepRecentTokens?: number;
    maxTokens?: number;
    reserveTokens?: number;
    speculativeStartRatio?: number;
    thresholdRatio?: number;
  };
  getContextLimit(): number;
  getContextUsage(): {
    limit: number;
    percentage: number;
    remaining: number;
    source: "actual" | "estimated";
    used: number;
  } | null;
  getEstimatedTokens(): number;
  getRecommendedMaxOutputTokens(
    messagesForLLM?: ModelMessage[]
  ): number | undefined;
  getRevision?(): number;
  handleContextOverflow?(error?: unknown): Promise<OverflowRecoveryResult>;
  isAtHardContextLimit(
    additionalTokens?: number,
    options?: { phase: "new-turn" | "intermediate-step" }
  ): boolean;
  toModelMessages(): ModelMessage[];
  updateActualUsage(usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }): void;
}

export interface AgentTUIMessageHistory
  extends MessageReadable,
    MessageWritable,
    ContextAware {}

const getMessageHistoryContextLimit = (
  history: Pick<AgentTUIMessageHistory, "getCompactionConfig"> & {
    getContextLimit?: () => number;
  }
): number => {
  if (typeof history.getContextLimit === "function") {
    return history.getContextLimit();
  }

  return history.getCompactionConfig().contextLimit ?? 0;
};

export function shouldDisplayBackgroundCompactionStatus(params: {
  blockingCompactionActive: boolean;
  state: "clear" | "running";
}): boolean {
  return !params.blockingCompactionActive && params.state === "running";
}

export function formatCompactionAppliedNotice(params: {
  detail: string;
  jobId?: string;
}): string {
  return params.jobId
    ? `↻ Background compaction applied: ${params.detail}`
    : `↻ Blocking compaction applied: ${params.detail}`;
}

export async function retryStreamTurnOnContextOverflow<T>(params: {
  error: unknown;
  overflowRetried: boolean;
  retry: () => Promise<T>;
  runBlockingCompaction: () => Promise<boolean>;
}): Promise<{ handled: false } | { handled: true; result: T }> {
  if (
    params.overflowRetried ||
    !(
      params.error instanceof AgentError &&
      params.error.code === AgentErrorCode.CONTEXT_OVERFLOW
    )
  ) {
    return { handled: false };
  }

  const didCompact = await params.runBlockingCompaction();
  if (!didCompact) {
    return { handled: false };
  }

  return {
    handled: true,
    result: await params.retry(),
  };
}

export async function retryStreamTurnOnNoOutput<T>(params: {
  error: unknown;
  noOutputRetryCount: number;
  retry: () => Promise<T>;
}): Promise<{ handled: false } | { handled: true; result: T }> {
  if (
    params.noOutputRetryCount >= 3 ||
    !(params.error instanceof Error) ||
    !params.error.message.includes("No output generated")
  ) {
    return { handled: false };
  }

  await new Promise((resolve) =>
    setTimeout(resolve, 250 * (params.noOutputRetryCount + 1))
  );

  return {
    handled: true,
    result: await params.retry(),
  };
}

export interface AgentTUIConfig {
  agent: RunnableAgent;
  circuitBreaker?: CompactionCircuitBreaker;
  commands?: Command[];
  compactionCallbacks?: CompactionOrchestratorCallbacks;
  contextPressureThresholds?: {
    critical?: number;
    elevated?: number;
    warning?: number;
  };
  footer?: { text?: string };
  header?: { title: string; subtitle?: string };
  measureUsage?: (messages: ModelMessage[]) => Promise<UsageMeasurement | null>;
  messageHistory: AgentTUIMessageHistory;
  onCommandAction?: (action: CommandAction) => void | Promise<void>;
  onSetup?: () => void | Promise<void>;
  onTurnComplete?: (
    messages: CheckpointMessage[],
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
    }
  ) => Promise<void> | void;
  preprocessCommand?: (
    commandInput: string,
    hooks: CommandPreprocessHooks
  ) => Promise<string | null>;
  preprocessUserInput?: (
    input: string,
    hooks: PreprocessHooks
  ) => Promise<PreprocessResult | undefined>;
  showRawToolIo?: boolean;
  skills?: SkillInfo[];
  theme?: { markdownTheme?: MarkdownTheme; editorTheme?: EditorTheme };
  toolRenderers?: ToolRendererMap;
}

export async function createAgentTUI(config: AgentTUIConfig): Promise<void> {
  const markdownTheme =
    config.theme?.markdownTheme ?? createDefaultMarkdownTheme();
  const editorTheme = config.theme?.editorTheme ?? createDefaultEditorTheme();
  const skills = config.skills ?? [];
  const { commands, commandLookup, commandAliasLookup } = buildTuiCommandSet(
    config.commands
  );

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  tui.setClearOnShrink(false);

  const headerContainer = new Container();
  const chatContainer = new Container();
  const statusContainer = new Container();
  const editorContainer = new Container();
  const footerContainer = new Container();
  const footerStatusBar = new FooterStatusBar(tui);

  const title = new Text("", 1, 0);
  const help = new Text(
    style(
      ANSI_DIM,
      "Enter to submit, Shift+Enter for newline, /help for commands, Esc to interrupt, Ctrl+C to clear, Ctrl+C twice to exit"
    ),
    1,
    0
  );

  const updateHeader = (): void => {
    const headerTitle = config.header?.title ?? "Agent TUI";
    const subtitle = config.header?.subtitle;
    const footer = config.footer?.text?.trim();
    const contextPressure = resolveContextPressure();
    title.setText(
      subtitle
        ? `${style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, headerTitle)}\n${style(ANSI_DIM, subtitle)}`
        : style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, headerTitle)
    );
    footerStatusBar.setRightText(footer, contextPressure ?? undefined);
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
  footerContainer.addChild(footerStatusBar);

  tui.addChild(headerContainer);
  tui.addChild(chatContainer);
  tui.addChild(statusContainer);
  tui.addChild(editorContainer);
  tui.addChild(footerContainer);
  tui.setFocus(editor);

  let shouldExit = false;
  let activeStreamController: AbortController | null = null;
  let streamInterruptRequested = false;
  let inputResolver: null | ((value: string | null) => void) = null;
  let lastCtrlCPressAt = 0;
  let foregroundStatus: StatusSpinner | null = null;
  const backgroundStatuses = new Map<string, FooterStatusEntry>();
  let blockingCompactionActive = false;
  let commandInputListenerActive = false;
  const contextPressureThresholds: ContextPressureThresholds = {
    elevated: config.contextPressureThresholds?.elevated ?? 0.7,
    warning: config.contextPressureThresholds?.warning ?? 0.85,
    critical: config.contextPressureThresholds?.critical ?? 0.95,
  };

  const resolveContextPressure = ():
    | "critical"
    | "elevated"
    | "normal"
    | "warning"
    | null => {
    const usage = config.messageHistory.getContextUsage();
    const contextLimit = getMessageHistoryContextLimit(config.messageHistory);
    if (!usage || contextLimit <= 0) {
      return null;
    }

    const compactionConfig = config.messageHistory.getCompactionConfig();
    const budget = computeContextBudget({
      contextLimit,
      maxOutputTokens: compactionConfig.maxTokens,
      reserveTokens: compactionConfig.reserveTokens,
      thresholdRatio: compactionConfig.thresholdRatio,
    });

    return getConfiguredContextPressureLevel(
      usage.used,
      budget,
      contextPressureThresholds
    );
  };

  const createStatusSpinner = (message: string): StatusSpinner => {
    return new StatusSpinner(
      tui,
      (text: string) => style(ANSI_CYAN, text),
      (text: string) => style(ANSI_DIM, text),
      message
    );
  };

  const renderForegroundStatus = (): void => {
    statusContainer.clear();
    if (foregroundStatus) {
      statusContainer.addChild(foregroundStatus);
    }
    tui.requestRender();
  };

  const renderFooterStatuses = (): void => {
    footerStatusBar.setEntries([...backgroundStatuses.values()]);
  };

  const clearBackgroundStatus = (id: string): void => {
    if (!backgroundStatuses.has(id)) {
      return;
    }
    backgroundStatuses.delete(id);
    renderFooterStatuses();
  };

  const setBackgroundStatus = (
    id: string,
    text: string,
    state: "ready" | "running" = "ready"
  ): void => {
    backgroundStatuses.set(id, { message: text, state });
    renderFooterStatuses();
  };

  const clearStatus = (): void => {
    if (!foregroundStatus) {
      tui.requestRender();
      return;
    }
    foregroundStatus.stop();
    foregroundStatus = null;
    renderForegroundStatus();
  };

  const showLoader = (message: string): void => {
    if (foregroundStatus) {
      foregroundStatus.stop();
    }
    foregroundStatus = createStatusSpinner(message);
    renderForegroundStatus();
  };

  const clearPromptInput = (): void => {
    editor.setText("");
    tui.setFocus(editor);
    tui.requestRender();
  };

  const addCompactionNotice = (message: string): void => {
    addChatComponent(chatContainer, new Text(style(ANSI_DIM, message), 1, 0));
    tui.requestRender();
  };

  const buildCompactionDetail = (
    saved: number,
    after: string,
    summarizedCount: number
  ): string => {
    if (saved <= 0) {
      return "restructured";
    }
    let detail = `−${saved} tokens (now ${after})`;
    if (summarizedCount > 0) {
      detail += `, ${summarizedCount} messages summarized`;
    }
    return detail;
  };

  const userCompactionCallbacks = config.compactionCallbacks;

  const compactionOrchestrator = new CompactionOrchestrator(
    config.messageHistory,
    {
      circuitBreaker: config.circuitBreaker,
      callbacks: {
        ...userCompactionCallbacks,
        onApplied: (appliedDetail) => {
          const { baseMessageCount, jobId, newMessageCount, tokenDelta } =
            appliedDetail;
          const saved = Math.abs(tokenDelta);
          const estimated = config.messageHistory.getEstimatedTokens();
          const after = estimated > 0 ? `${estimated}` : "?";
          const summarizedCount = baseMessageCount - newMessageCount;
          const detailText = buildCompactionDetail(
            saved,
            after,
            summarizedCount
          );
          addCompactionNotice(
            formatCompactionAppliedNotice({ detail: detailText, jobId })
          );
          updateHeader();
          tui.requestRender();
          userCompactionCallbacks?.onApplied?.(appliedDetail);
        },
        onBlockingChange: (event) => {
          if (event.blocking) {
            blockingCompactionActive = true;
            backgroundStatuses.clear();
            setBackgroundStatus(
              "blocking-compaction",
              "Compacting...",
              "running"
            );
            userCompactionCallbacks?.onBlockingChange?.(event);
            return;
          }

          blockingCompactionActive = false;
          clearBackgroundStatus("blocking-compaction");
          updateHeader();
          tui.requestRender();
          userCompactionCallbacks?.onBlockingChange?.(event);
        },
        onCompactionComplete: (result) => {
          userCompactionCallbacks?.onCompactionComplete?.(result);
        },
        onCompactionError: (error) => {
          userCompactionCallbacks?.onCompactionError?.(error);
        },
        onError: (message, error) => {
          console.error(`${message}:`, error);
          userCompactionCallbacks?.onError?.(message, error);
        },
        onJobStatus: (id, message, state) => {
          if (
            !shouldDisplayBackgroundCompactionStatus({
              blockingCompactionActive,
              state,
            })
          ) {
            if (state === "clear") {
              clearBackgroundStatus(id);
            }
            updateHeader();
            tui.requestRender();
            userCompactionCallbacks?.onJobStatus?.(id, message, state);
            return;
          }

          if (state === "running") {
            setBackgroundStatus(id, "Background compaction...", "running");
          } else {
            clearBackgroundStatus(id);
          }
          updateHeader();
          tui.requestRender();
          userCompactionCallbacks?.onJobStatus?.(id, message, state);
        },
        onRejected: () => {
          addCompactionNotice("↻ Compaction skipped (no token reduction)");
          updateHeader();
          tui.requestRender();
          userCompactionCallbacks?.onRejected?.();
        },
        onSpeculativeReady: () => {
          const result = compactionOrchestrator.applyReady();
          if (result.applied) {
            measureUsageAfterCompaction()
              .then(() => {
                updateHeader();
                tui.requestRender();
              })
              .catch(Boolean);
          }
          userCompactionCallbacks?.onSpeculativeReady?.();
        },
        onStillExceeded: () => {
          addCompactionNotice(
            "↻ Compaction: context limit still tight after retries — older messages were condensed, some detail may be lost"
          );
          updateHeader();
          tui.requestRender();
          userCompactionCallbacks?.onStillExceeded?.();
        },
      },
    }
  );

  const applyReadySpeculativeCompaction = (): {
    applied: boolean;
    stale: boolean;
  } => compactionOrchestrator.applyReady();

  const blockAtHardContextLimit = async (
    additionalTokens: number,
    phase: "new-turn" | "intermediate-step"
  ): Promise<void> => {
    await compactionOrchestrator.blockAtHardLimit(additionalTokens, phase);
  };

  const blockOnlyIfAtHardContextLimit = async (
    userContent: string
  ): Promise<void> => {
    await blockAtHardContextLimit(estimateTokens(userContent), "new-turn");
  };

  const startSpeculativeCompaction = (): void => {
    compactionOrchestrator.startSpeculative();
  };

  const compactBeforeNextTurnIfNeeded = async (): Promise<void> => {
    const didBlockingCompact = await compactionOrchestrator.checkAndCompact();
    const readyResult = applyReadySpeculativeCompaction();
    if (didBlockingCompact || readyResult.applied) {
      await measureUsageAfterCompaction();
    }
  };

  const measureUsageIfAvailable = async (
    messages: ModelMessage[]
  ): Promise<boolean> => {
    if (!config.measureUsage) {
      return false;
    }

    const measured = normalizeUsageMeasurement(
      await config.measureUsage(messages)
    );
    if (!measured) {
      return false;
    }

    config.messageHistory.updateActualUsage({
      inputTokens: measured.inputTokens,
      outputTokens: measured.outputTokens,
      totalTokens: measured.totalTokens,
    });
    updateHeader();
    return true;
  };

  const measureUsageAfterCompaction = async (): Promise<void> => {
    if (!config.measureUsage) {
      return;
    }
    const messages = config.messageHistory.getMessagesForLLM();
    await measureUsageIfAvailable(messages);
  };

  const cancelActiveStream = (): boolean => {
    if (!activeStreamController || activeStreamController.signal.aborted) {
      return false;
    }

    streamInterruptRequested = true;
    addSystemMessage(chatContainer, "⚡ Interrupted");
    activeStreamController.abort("User requested stream interruption");
    return true;
  };

  const requestExit = (): void => {
    shouldExit = true;
    cancelActiveStream();
    compactionOrchestrator.discardAll();
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

  const isEscapeInput = (data: string): boolean => {
    if (isKeyRelease(data) || isKeyRepeat(data)) {
      return false;
    }

    return matchesKey(data, Key.escape);
  };

  const handleCtrlCPress = (): void => {
    const now = Date.now();
    if (now - lastCtrlCPressAt < CTRL_C_EXIT_WINDOW_MS) {
      requestExit();
      return;
    }

    clearPromptInput();
    lastCtrlCPressAt = now;
  };

  const onTerminalResize = (): void => {
    tui.requestRender(true);
  };

  const removeInputListener = tui.addInputListener((data) => {
    if (isCtrlCInput(data) && !commandInputListenerActive) {
      handleCtrlCPress();
      return { consume: true };
    }
    if (
      isEscapeInput(data) &&
      !commandInputListenerActive &&
      activeStreamController &&
      !activeStreamController.signal.aborted
    ) {
      cancelActiveStream();
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

  const prepareMessages = async (
    phase: "new-turn" | "intermediate-step"
  ): Promise<ModelMessage[]> => {
    const readyResult = applyReadySpeculativeCompaction();
    if (readyResult.stale) {
      startSpeculativeCompaction();
    }
    if (readyResult.applied) {
      await measureUsageAfterCompaction();
    }

    await blockAtHardContextLimit(0, phase);

    let messagesForLLM = config.messageHistory.getMessagesForLLM();
    const didProbe = await measureUsageIfAvailable(messagesForLLM);
    await compactBeforeNextTurnIfNeeded();
    if (didProbe) {
      await blockAtHardContextLimit(1, phase);
    }
    messagesForLLM = config.messageHistory.getMessagesForLLM();

    startSpeculativeCompaction();
    return messagesForLLM;
  };

  const createStreamingLoaderClearer = (): (() => void) => {
    let hasClearedStreamingLoader = false;

    return () => {
      if (hasClearedStreamingLoader) {
        return;
      }
      hasClearedStreamingLoader = true;
      clearStatus();
    };
  };

  const addInterruptedMessage = (): void => {
    addChatComponent(
      chatContainer,
      new Text(
        style(
          ANSI_RED,
          "■ interrupted - tell the model what to do differently."
        ),
        1,
        0
      )
    );
    tui.requestRender();
  };

  const addAbnormalFinishReasonMessage = (finishReason: string): void => {
    if (finishReason === "stop") {
      return;
    }

    addChatComponent(
      chatContainer,
      new Text(
        style(
          ANSI_RED,
          `■ response ended abnormally (finish reason: ${finishReason})`
        ),
        1,
        0
      )
    );
    tui.requestRender();
  };

  const logStreamUsage = (
    usage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        }
      | null
      | undefined
  ): void => {
    if (!(usage && harnessEnv.DEBUG_TOKENS)) {
      return;
    }

    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const total = usage.totalTokens ?? input + output;
    console.error(
      `[debug:tui] total_tokens=${total} (input=${input}, output=${output})`
    );
  };

  const resolveTurnBudget = async (
    phase: "new-turn" | "intermediate-step",
    messagesForLLM: ModelMessage[]
  ): Promise<{ maxOutputTokens?: number; messagesForLLM: ModelMessage[] }> => {
    let nextMessages = messagesForLLM;
    let maxOutputTokens =
      config.messageHistory.getRecommendedMaxOutputTokens(nextMessages);

    if (maxOutputTokens !== undefined && maxOutputTokens <= 512) {
      await blockAtHardContextLimit(1, phase);
      nextMessages = config.messageHistory.getMessagesForLLM();
      maxOutputTokens = Math.max(
        512,
        config.messageHistory.getRecommendedMaxOutputTokens(nextMessages) ?? 512
      );
    }

    return {
      messagesForLLM: nextMessages,
      maxOutputTokens,
    };
  };

  const finalizeSuccessfulStreamTurn = async (params: {
    finishReason: string;
    responseMessages: ModelMessage[];
    streamAbortController: AbortController;
    usage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        }
      | null
      | undefined;
  }): Promise<"completed" | "continue" | "interrupted"> => {
    logStreamUsage(params.usage);

    if (
      streamInterruptRequested ||
      params.streamAbortController.signal.aborted
    ) {
      addInterruptedMessage();
      return "interrupted";
    }

    applyReadySpeculativeCompaction();
    config.messageHistory.addModelMessages(params.responseMessages);
    const normalizedUsage = normalizeUsageMeasurement(params.usage);
    if (normalizedUsage) {
      config.messageHistory.updateActualUsage(normalizedUsage);
    }
    const onTurnCompleteUsage = normalizedUsage
      ? {
          inputTokens: normalizedUsage.inputTokens,
          outputTokens: normalizedUsage.outputTokens,
        }
      : undefined;
    Promise.resolve(
      config.onTurnComplete?.(
        config.messageHistory.getAll(),
        onTurnCompleteUsage
      )
    ).catch((error) => {
      console.error("onTurnComplete callback failed in TUI:", error);
    });
    updateHeader();
    startSpeculativeCompaction();
    await compactBeforeNextTurnIfNeeded();

    if (shouldContinueManualToolLoop(params.finishReason)) {
      return "continue";
    }

    addAbnormalFinishReasonMessage(params.finishReason);

    return "completed";
  };

  const handleStreamTurnError = async (params: {
    error: unknown;
    noOutputRetryCount: number;
    overflowRetried: boolean;
    phase: "new-turn" | "intermediate-step";
    streamAbortController: AbortController;
  }): Promise<"completed" | "continue" | "interrupted"> => {
    if (
      streamInterruptRequested ||
      params.streamAbortController.signal.aborted
    ) {
      addInterruptedMessage();
      return "interrupted";
    }

    const overflowRetry = await retryStreamTurnOnContextOverflow({
      error: params.error,
      overflowRetried: params.overflowRetried,
      runBlockingCompaction: async () => {
        const result = await compactionOrchestrator.handleOverflow(
          params.error
        );
        return result.success;
      },
      retry: async () => runSingleStreamTurn(params.phase, true),
    });
    if (overflowRetry.handled) {
      return overflowRetry.result;
    }

    const noOutputRetry = await retryStreamTurnOnNoOutput({
      error: params.error,
      noOutputRetryCount: params.noOutputRetryCount,
      retry: async () =>
        runSingleStreamTurn(
          params.phase,
          params.overflowRetried,
          params.noOutputRetryCount + 1
        ),
    });
    if (noOutputRetry.handled) {
      return noOutputRetry.result;
    }

    throw params.error;
  };

  const runSingleStreamTurn = async (
    phase: "new-turn" | "intermediate-step",
    overflowRetried = false,
    noOutputRetryCount = 0
  ): Promise<"completed" | "continue" | "interrupted"> => {
    let messagesForLLM = await prepareMessages(phase);

    showLoader("Working...");
    const streamAbortController = new AbortController();
    activeStreamController = streamAbortController;
    streamInterruptRequested = false;

    try {
      const budget = await resolveTurnBudget(phase, messagesForLLM);
      messagesForLLM = budget.messagesForLLM;
      const stream = await config.agent.stream({
        messages: messagesForLLM,
        abortSignal: streamAbortController.signal,
        ...(budget.maxOutputTokens !== undefined
          ? { maxOutputTokens: budget.maxOutputTokens }
          : {}),
      });

      const clearStreamingLoader = createStreamingLoaderClearer();

      await renderAgentStream(
        stream.fullStream as AsyncIterable<unknown>,
        {
          showReasoning: true,
          showSteps: false,
          showFinishReason: false,
          showRawToolIo: config.showRawToolIo ?? false,
          showToolResults: true,
          showSources: false,
          showFiles: false,
        },
        clearStreamingLoader
      );

      clearStreamingLoader();

      const [response, finishReason, usage] = await Promise.all([
        stream.response,
        stream.finishReason,
        stream.usage,
      ]);

      return await finalizeSuccessfulStreamTurn({
        finishReason,
        responseMessages: response.messages,
        streamAbortController,
        usage,
      });
    } catch (error) {
      return await handleStreamTurnError({
        error,
        noOutputRetryCount,
        overflowRetried,
        phase,
        streamAbortController,
      });
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
    let phase: "new-turn" | "intermediate-step" = "new-turn";

    while (true) {
      const turnStatus = await runSingleStreamTurn(phase);
      if (turnStatus === "continue") {
        startSpeculativeCompaction();
        phase = "intermediate-step";
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

  const preprocessCommandInput = async (
    input: string
  ): Promise<string | null> => {
    if (!config.preprocessCommand) {
      return input;
    }

    return await config.preprocessCommand(input, {
      addInputListener: (listener) => {
        commandInputListenerActive = true;
        const remove = tui.addInputListener(listener);
        return () => {
          remove();
          commandInputListenerActive = false;
        };
      },
      clearStatus,
      tui,
      statusContainer,
      editorTheme,
      isCtrlCInput,
      handleCtrlCPress,
      showMessage: (message: string) =>
        addSystemMessage(chatContainer, message),
      updateHeader,
    });
  };

  const handleNewSessionAction = async (
    commandResult: CommandResult
  ): Promise<void> => {
    if (!commandResult.action) {
      return;
    }

    compactionOrchestrator.discardAll();
    config.messageHistory.reset?.() ?? config.messageHistory.clear();
    chatContainer.clear();
    addNewSessionMessage(chatContainer);
    await config.onCommandAction?.(commandResult.action);
    await measureUsageIfAvailable([]);
    updateHeader();

    if (commandResult.message) {
      addSystemMessage(chatContainer, commandResult.message);
    }
    tui.requestRender();
  };

  const handleCompactAction = async (
    commandResult: CommandResult
  ): Promise<void> => {
    if (!commandResult.action) {
      return;
    }

    showLoader("Compacting...");
    try {
      const result = await compactionOrchestrator.manualCompact();
      if (result.success) {
        await measureUsageAfterCompaction();
        startSpeculativeCompaction();
        if (commandResult.message) {
          addSystemMessage(chatContainer, commandResult.message);
        }
      } else {
        addSystemMessage(
          chatContainer,
          `Compaction failed: ${result.reason ?? "unknown reason"}`
        );
      }

      await config.onCommandAction?.(commandResult.action);
      updateHeader();
      tui.requestRender();
    } finally {
      clearStatus();
    }
  };

  const handleCommandResult = async (
    commandResult: CommandResult | null
  ): Promise<void> => {
    if (!(commandResult?.success && commandResult.action)) {
      if (commandResult?.message) {
        addSystemMessage(chatContainer, commandResult.message);
      }
      tui.requestRender();
      return;
    }

    if (commandResult.action.type === "new-session") {
      await handleNewSessionAction(commandResult);
      return;
    }

    if (commandResult.action.type === "compact") {
      await handleCompactAction(commandResult);
      return;
    }

    if (commandResult.message) {
      addSystemMessage(chatContainer, commandResult.message);
    }
    tui.requestRender();
  };

  const processCommandInput = async (trimmed: string): Promise<boolean> => {
    const commandInput = await preprocessCommandInput(trimmed);
    if (commandInput === null) {
      tui.requestRender();
      return true;
    }

    let commandResult: CommandResult | null | undefined;
    commandResult =
      (await executeLocalCommand(commandInput)) ??
      (await executeCommand(commandInput));

    if (isSkillCommandResult(commandResult)) {
      addUserMessage(chatContainer, markdownTheme, trimmed);
      await blockOnlyIfAtHardContextLimit(commandResult.skillContent);
      config.messageHistory.addUserMessage(commandResult.skillContent);
      compactionOrchestrator.notifyNewUserTurn();
      tui.requestRender();
      const responseState = await processAgentResponse();
      if (responseState === "completed") {
        startSpeculativeCompaction();
      }
      return true;
    }

    await handleCommandResult(commandResult);
    return true;
  };

  const processUserInputMessage = async (trimmed: string): Promise<void> => {
    let contentForModel = trimmed;

    if (config.preprocessUserInput) {
      addUserMessage(chatContainer, markdownTheme, trimmed);
      tui.requestRender();

      const result = await config.preprocessUserInput(trimmed, {
        showStatus: (text: string) => showLoader(text),
        clearStatus: () => clearStatus(),
      });

      if (result) {
        if (result.success) {
          contentForModel = result.message;

          if (result.translatedDisplay) {
            addTranslatedMessage(
              chatContainer,
              markdownTheme,
              result.translatedDisplay
            );
          }
        } else {
          addSystemMessage(chatContainer, result.error);
        }
      }
    } else {
      addUserMessage(chatContainer, markdownTheme, trimmed);
    }

    await blockOnlyIfAtHardContextLimit(contentForModel);
    config.messageHistory.addUserMessage(contentForModel);
    compactionOrchestrator.notifyNewUserTurn();
    tui.requestRender();
    const responseState = await processAgentResponse();
    if (responseState === "completed") {
      startSpeculativeCompaction();
    }
  };

  const processInput = async (input: string): Promise<boolean> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      addSystemMessage(chatContainer, "메시지를 입력해주세요");
      tui.requestRender();
      return true;
    }

    try {
      editor.disableSubmit = true;
      editor.setText("");
      tui.requestRender();
      const inputReadyResult = applyReadySpeculativeCompaction();
      if (inputReadyResult.stale) {
        startSpeculativeCompaction();
      }
      if (inputReadyResult.applied) {
        await measureUsageAfterCompaction();
      }

      if (isCommand(trimmed)) {
        return await processCommandInput(trimmed);
      }

      await processUserInputMessage(trimmed);
      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      addSystemMessage(chatContainer, `Error: ${errorMessage}`);
      tui.requestRender();
      return true;
    } finally {
      editor.disableSubmit = false;
      tui.setFocus(editor);
      tui.requestRender();
    }
  };

  updateHeader();
  tui.start();

  try {
    await config.onSetup?.();
    await measureUsageIfAvailable([]);
    updateHeader();

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
    compactionOrchestrator.discardAll();
    clearStatus();
    footerStatusBar.stop();
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
