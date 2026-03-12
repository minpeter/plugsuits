import {
  type Command,
  type CommandAction,
  type CommandResult,
  estimateTokens,
  executeCommand,
  isCommand,
  isSkillCommandResult,
  type MessageHistory,
  type ModelMessage,
  type PreparedCompaction,
  parseCommand,
  type RunnableAgent,
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
const ANSI_RED = "\x1b[31m";
const CTRL_C_ETX = "\u0003";
const CTRL_C_EXIT_WINDOW_MS = 500;

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
  message: string;
  state: "ready" | "running";
}

class FooterStatusBar extends Text {
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private currentFrame = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private entries: FooterStatusEntry[] = [];
  private rightText: string | undefined;
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

  setRightText(text: string | undefined): void {
    this.rightText = text?.trim() || undefined;
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
      ? style(ANSI_DIM, rightTextPlain)
      : "";

    const renderLeftEntry = (
      entry: FooterStatusEntry,
      maxWidth: number
    ): { plain: string; styled: string } => {
      const prefix =
        entry.state === "running" ? this.frames[this.currentFrame] : "";
      const prefixStyle =
        entry.state === "running" ? style(ANSI_CYAN, prefix) : "";
      const reservedPrefixWidth = prefix ? visibleWidth(prefix) + 1 : 0;
      const maxMessageWidth = Math.max(0, maxWidth - reservedPrefixWidth);
      const message = truncatePlainToWidth(entry.message, maxMessageWidth);

      return {
        plain: prefix ? `${prefix}${message ? ` ${message}` : ""}` : message,
        styled: prefix
          ? `${prefixStyle}${message ? ` ${style(ANSI_DIM, message)}` : ""}`
          : style(ANSI_DIM, message),
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

export interface PreprocessResult {
  contentForModel: string;
  error?: string;
  originalContent?: string;
  translatedDisplay?: string;
}

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

export interface AgentTUIConfig {
  agent: RunnableAgent;
  commands?: Command[];
  footer?: { text?: string };
  header?: { title: string; subtitle?: string };
  messageHistory: MessageHistory;
  onCommandAction?: (action: CommandAction) => void | Promise<void>;
  onSetup?: () => void | Promise<void>;
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

interface SpeculativeCompactionJob {
  discarded: boolean;
  id: string;
  phase: "new-turn";
  prepared: PreparedCompaction | null;
  promise: Promise<void>;
  state: "completed" | "failed" | "running";
}

type CompactionPhase = "new-turn" | "intermediate-step";

export function discardAllSpeculativeCompactionJobsCore(params: {
  discardJob: (job: SpeculativeCompactionJob) => void;
  jobs: SpeculativeCompactionJob[];
}): void {
  for (const job of [...params.jobs]) {
    params.discardJob(job);
  }
}

export function applyReadySpeculativeCompactionCore(params: {
  applyPreparedCompaction: (prepared: PreparedCompaction) => {
    applied: boolean;
    reason: "applied" | "noop" | "stale" | "rejected";
  };
  discardAllJobs: () => void;
  discardJob: (job: SpeculativeCompactionJob) => void;
  jobs: SpeculativeCompactionJob[];
  onStale: () => void;
  onRejected?: () => void;
}): { applied: boolean; stale: boolean } {
  let applied = false;
  let stale = false;
  let didRefire = false;

  for (let i = params.jobs.length - 1; i >= 0; i--) {
    const job = params.jobs[i];
    if (job.discarded || job.state !== "completed" || !job.prepared) {
      continue;
    }

    const result = params.applyPreparedCompaction(job.prepared);
    params.discardJob(job);

    if (result.reason === "stale") {
      stale = true;
      if (!didRefire) {
        params.onStale();
        didRefire = true;
      }
      continue;
    }

    if (result.reason === "rejected") {
      params.onRejected?.();
      continue;
    }

    if (result.reason === "applied") {
      params.discardAllJobs();
      applied = true;
    }
    break;
  }

  return { applied, stale };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: hard-limit blocking requires multiple retry branches
export async function blockAtHardContextLimitCore(params: {
  additionalTokens: number;
  applyPreparedCompaction: (prepared: PreparedCompaction) => {
    applied: boolean;
    reason: "applied" | "noop" | "stale" | "rejected";
  };
  applyReadySpeculativeCompaction: () => {
    applied: boolean;
    stale: boolean;
  };
  getLatestRunningSpeculativeCompaction: () => SpeculativeCompactionJob | null;
  isAtHardContextLimit: (
    additionalTokens: number,
    options: { phase: CompactionPhase }
  ) => boolean;
  phase: CompactionPhase;
  prepareSpeculativeCompaction: (
    phase: CompactionPhase
  ) => Promise<PreparedCompaction | null>;
  warnHardLimitStillExceeded: () => void;
}): Promise<void> {
  if (
    !params.isAtHardContextLimit(params.additionalTokens, {
      phase: params.phase,
    })
  ) {
    return;
  }

  const attemptPhases: CompactionPhase[] = [params.phase, "new-turn"];

  for (let attempt = 0; attempt < attemptPhases.length; attempt++) {
    if (
      !params.isAtHardContextLimit(params.additionalTokens, {
        phase: params.phase,
      })
    ) {
      return;
    }

    const runningJob = params.getLatestRunningSpeculativeCompaction();
    if (runningJob) {
      await runningJob.promise;
    } else {
      const prepared = await params.prepareSpeculativeCompaction(
        attemptPhases[attempt]
      );
      if (prepared) {
        const result = params.applyPreparedCompaction(prepared);
        if (result.reason === "stale" && attempt === 0) {
          const retryPrepared =
            await params.prepareSpeculativeCompaction("new-turn");
          if (retryPrepared) {
            params.applyPreparedCompaction(retryPrepared);
          }
          break;
        }
        // Treat "rejected" as terminal - no retry with different phase
        if (result.reason === "rejected") {
          break;
        }
      }
    }

    const readyResult = params.applyReadySpeculativeCompaction();
    if (readyResult.stale && attempt === 0) {
      const retryPrepared =
        await params.prepareSpeculativeCompaction("new-turn");
      if (retryPrepared) {
        params.applyPreparedCompaction(retryPrepared);
      }
      break;
    }
  }

  if (
    params.isAtHardContextLimit(params.additionalTokens, {
      phase: params.phase,
    })
  ) {
    params.warnHardLimitStillExceeded();
  }
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
    title.setText(
      subtitle
        ? `${style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, headerTitle)}\n${style(ANSI_DIM, subtitle)}`
        : style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, headerTitle)
    );
    footerStatusBar.setRightText(footer);
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
  const speculativeCompactionJobs: SpeculativeCompactionJob[] = [];
  let speculativeCompactionJobCounter = 0;
  let commandInputListenerActive = false;

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

  const discardSpeculativeCompactionJob = (
    job: SpeculativeCompactionJob
  ): void => {
    job.discarded = true;
    clearBackgroundStatus(job.id);
    const index = speculativeCompactionJobs.indexOf(job);
    if (index !== -1) {
      speculativeCompactionJobs.splice(index, 1);
    }
  };

  const discardAllSpeculativeCompactionJobs = (): void => {
    discardAllSpeculativeCompactionJobsCore({
      jobs: speculativeCompactionJobs,
      discardJob: discardSpeculativeCompactionJob,
    });
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

  const applyReadySpeculativeCompaction = (): {
    applied: boolean;
    stale: boolean;
  } => {
    let appliedTokenDelta = 0;
    let baseMessageCount = 0;
    let newMessageCount = 0;
    const result = applyReadySpeculativeCompactionCore({
      jobs: speculativeCompactionJobs,
      applyPreparedCompaction: (prepared) => {
        appliedTokenDelta = prepared.tokenDelta;
        baseMessageCount = prepared.baseMessageIds.length;
        newMessageCount = prepared.messages.length;
        return config.messageHistory.applyPreparedCompaction(prepared);
      },
      discardJob: discardSpeculativeCompactionJob,
      discardAllJobs: discardAllSpeculativeCompactionJobs,
      onStale: () => startSpeculativeCompaction(),
      onRejected: () => {
        addCompactionNotice("↻ Compaction skipped (no token reduction)");
      },
    });

    if (result.applied) {
      const saved = Math.abs(appliedTokenDelta);
      const usage = config.messageHistory.getContextUsage();
      const after = usage ? `${usage.used}` : "?";
      const summarizedCount = baseMessageCount - newMessageCount;
      const detail = buildCompactionDetail(saved, after, summarizedCount);
      addCompactionNotice(`↻ Compacted: ${detail}`);
      updateHeader();
      tui.requestRender();
    }

    return result;
  };

  const getLatestRunningSpeculativeCompaction =
    (): SpeculativeCompactionJob | null => {
      for (let i = speculativeCompactionJobs.length - 1; i >= 0; i--) {
        const job = speculativeCompactionJobs[i];
        if (!job.discarded && job.state === "running") {
          return job;
        }
      }
      return null;
    };

  const blockAtHardContextLimit = async (
    additionalTokens: number,
    phase: "new-turn" | "intermediate-step"
  ): Promise<void> => {
    const needsBlocking = config.messageHistory.isAtHardContextLimit(
      additionalTokens,
      { phase }
    );
    if (needsBlocking) {
      showLoader("Compacting...");
    }

    let lastAppliedDelta = 0;
    let didApply = false;
    let lastReason = "noop" as string;
    let lastBaseMessageCount = 0;
    let lastNewMessageCount = 0;
    await blockAtHardContextLimitCore({
      additionalTokens,
      phase,
      isAtHardContextLimit: (tokens, options) =>
        config.messageHistory.isAtHardContextLimit(tokens, options),
      getLatestRunningSpeculativeCompaction,
      prepareSpeculativeCompaction: (attemptPhase) =>
        config.messageHistory.prepareSpeculativeCompaction({
          phase: attemptPhase,
        }),
      applyPreparedCompaction: (prepared) => {
        lastAppliedDelta = prepared.tokenDelta;
        lastBaseMessageCount = prepared.baseMessageIds.length;
        lastNewMessageCount = prepared.messages.length;
        const result = config.messageHistory.applyPreparedCompaction(prepared);
        lastReason = result.reason;
        if (result.reason === "applied") {
          didApply = true;
        }
        return result;
      },
      applyReadySpeculativeCompaction,
      warnHardLimitStillExceeded: () => {
        addCompactionNotice(
          "↻ Compaction: context limit still tight after retries — older messages were condensed, some detail may be lost"
        );
      },
    });

    if (needsBlocking) {
      clearStatus();
      if (didApply) {
        const saved = Math.abs(lastAppliedDelta);
        const usage = config.messageHistory.getContextUsage();
        const after = usage ? `${usage.used}` : "?";
        const summarizedCount = lastBaseMessageCount - lastNewMessageCount;
        const detail = buildCompactionDetail(saved, after, summarizedCount);
        addCompactionNotice(`↻ Compacted: ${detail}`);
      } else if (lastReason === "rejected") {
        addCompactionNotice("↻ Compaction skipped (no token reduction)");
      }
    }
    updateHeader();
    tui.requestRender();
  };

  const blockOnlyIfAtHardContextLimit = async (
    userContent: string
  ): Promise<void> => {
    await blockAtHardContextLimit(estimateTokens(userContent), "new-turn");
  };

  const startSpeculativeCompaction = (): void => {
    applyReadySpeculativeCompaction();
    if (
      speculativeCompactionJobs.some(
        (job) =>
          !job.discarded &&
          (job.state === "running" || job.state === "completed")
      )
    ) {
      return;
    }

    if (!config.messageHistory.shouldStartSpeculativeCompactionForNextTurn()) {
      return;
    }

    const jobId = `background-compaction-${++speculativeCompactionJobCounter}`;
    const job: SpeculativeCompactionJob = {
      discarded: false,
      id: jobId,
      phase: "new-turn",
      prepared: null,
      promise: Promise.resolve(),
      state: "running",
    };

    setBackgroundStatus(jobId, "Compacting...", "running");

    job.promise = (async () => {
      try {
        job.prepared = await config.messageHistory.prepareSpeculativeCompaction(
          {
            phase: "new-turn",
          }
        );
        job.state = "completed";

        if (!job.discarded) {
          clearBackgroundStatus(jobId);
          updateHeader();
          tui.requestRender();
        }
      } catch (error) {
        job.state = "failed";
        clearBackgroundStatus(jobId);
        console.error("Speculative compaction failed:", error);
      }
    })();

    speculativeCompactionJobs.push(job);
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
    discardAllSpeculativeCompactionJobs();
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
    applyReadySpeculativeCompaction();

    if (config.messageHistory.isAtHardContextLimit(0, { phase })) {
      await blockAtHardContextLimit(0, phase);
    }

    const messagesForLLM = config.messageHistory.getMessagesForLLM();
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
    if (!(usage && process.env.DEBUG_TOKENS)) {
      return;
    }

    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const total = usage.totalTokens ?? input + output;
    console.error(
      `[debug:tui] total_tokens=${total} (input=${input}, output=${output})`
    );
  };

  const runSingleStreamTurn = async (
    phase: "new-turn" | "intermediate-step"
  ): Promise<"completed" | "continue" | "interrupted"> => {
    const messagesForLLM = await prepareMessages(phase);

    showLoader("Working...");
    const streamAbortController = new AbortController();
    activeStreamController = streamAbortController;
    streamInterruptRequested = false;

    try {
      const maxOutputTokens =
        config.messageHistory.getRecommendedMaxOutputTokens(messagesForLLM);
      const stream = await config.agent.stream({
        messages: messagesForLLM,
        abortSignal: streamAbortController.signal,
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
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

      logStreamUsage(usage);

      if (streamInterruptRequested || streamAbortController.signal.aborted) {
        addInterruptedMessage();
        return "interrupted";
      }

      applyReadySpeculativeCompaction();
      config.messageHistory.addModelMessages(response.messages);
      config.messageHistory.updateActualUsage(usage);
      updateHeader();

      if (shouldContinueManualToolLoop(finishReason)) {
        return "continue";
      }

      addAbnormalFinishReasonMessage(finishReason);

      return "completed";
    } catch (error) {
      if (streamInterruptRequested || streamAbortController.signal.aborted) {
        addInterruptedMessage();
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
      discardAllSpeculativeCompactionJobs();
      config.messageHistory.clear();
      chatContainer.clear();
      addNewSessionMessage(chatContainer);
      await config.onCommandAction?.(commandResult.action);
      updateHeader();

      if (commandResult.message) {
        addSystemMessage(chatContainer, commandResult.message);
      }
      tui.requestRender();
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

    const parsedForLoader = parseCommand(commandInput);
    const isCompactCommand = parsedForLoader?.name === "compact";
    if (isCompactCommand) {
      showLoader("Compacting...");
    }

    let commandResult: CommandResult | null | undefined;
    try {
      commandResult =
        (await executeLocalCommand(commandInput)) ??
        (await executeCommand(commandInput));
    } finally {
      if (isCompactCommand) {
        clearStatus();
      }
    }

    if (isSkillCommandResult(commandResult)) {
      addUserMessage(chatContainer, markdownTheme, trimmed);
      await blockOnlyIfAtHardContextLimit(commandResult.skillContent);
      config.messageHistory.addUserMessage(commandResult.skillContent);
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
    let originalContent: string | undefined;

    if (config.preprocessUserInput) {
      addUserMessage(chatContainer, markdownTheme, trimmed);
      tui.requestRender();

      const result = await config.preprocessUserInput(trimmed, {
        showStatus: (text: string) => showLoader(text),
        clearStatus: () => clearStatus(),
      });

      if (result) {
        contentForModel = result.contentForModel;
        originalContent = result.originalContent;

        if (result.translatedDisplay) {
          addTranslatedMessage(
            chatContainer,
            markdownTheme,
            result.translatedDisplay
          );
        }

        if (result.error) {
          addSystemMessage(chatContainer, result.error);
        }
      }
    } else {
      addUserMessage(chatContainer, markdownTheme, trimmed);
    }

    await blockOnlyIfAtHardContextLimit(contentForModel);
    config.messageHistory.addUserMessage(contentForModel, originalContent);
    tui.requestRender();
    const responseState = await processAgentResponse();
    if (responseState === "completed") {
      startSpeculativeCompaction();
    }
  };

  const processInput = async (input: string): Promise<boolean> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return true;
    }

    try {
      editor.disableSubmit = true;
      editor.setText("");
      tui.requestRender();
      applyReadySpeculativeCompaction();

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
    discardAllSpeculativeCompactionJobs();
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
