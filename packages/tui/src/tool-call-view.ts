import {
  Container,
  Markdown,
  type MarkdownTheme,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { parsePartialJson } from "ai";

const UNKNOWN_TOOL_NAME = "tool";
const TRAILING_NEWLINES = /\n+$/;
const TAB_PATTERN = /\t/g;
const BACKTICK_FENCE_PATTERN = /`{3,}/g;

const ANSI_RESET = "\x1b[0m";
const ANSI_BG_GRAY = "\x1b[100m";
const ANSI_BG_DARK_RED = "\x1b[48;5;88m";

const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const renderCodeBlock = (language: string, value: unknown): string => {
  const text = safeStringify(value).replace(TRAILING_NEWLINES, "");
  const longestFenceRun = Array.from(
    text.matchAll(BACKTICK_FENCE_PATTERN)
  ).reduce((max, match) => Math.max(max, match[0].length), 2);
  const fence = "`".repeat(longestFenceRun + 1);
  return `${fence}${language}\n${text}\n${fence}`;
};

const isPlainEmptyObject = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).length === 0;
};

const applyGrayBackground = (text: string): string =>
  `${ANSI_BG_GRAY}${text}${ANSI_RESET}`;

const applyErrorBackground = (text: string): string =>
  `${ANSI_BG_DARK_RED}${text}${ANSI_RESET}`;

class TrimmedMarkdown extends Markdown {
  override render(width: number): string[] {
    const lines = super.render(width);
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim().length === 0) {
      end -= 1;
    }
    return lines.slice(0, end);
  }
}

class BackgroundBody {
  private cachedLines?: string[];
  private cachedText?: string;
  private cachedWidth?: number;
  private backgroundFn: (text: string) => string;
  private backgroundEnabled = true;
  private readonly paddingX: number;
  private text: string;

  constructor(
    text: string,
    paddingX: number,
    backgroundFn: (text: string) => string
  ) {
    this.text = text;
    this.paddingX = paddingX;
    this.backgroundFn = backgroundFn;
  }

  setText(text: string): void {
    this.text = text;
    this.invalidate();
  }

  setBackground(backgroundFn: (text: string) => string): void {
    this.backgroundFn = backgroundFn;
    this.invalidate();
  }

  setBackgroundEnabled(enabled: boolean): void {
    if (this.backgroundEnabled === enabled) {
      return;
    }
    this.backgroundEnabled = enabled;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (
      this.cachedLines &&
      this.cachedText === this.text &&
      this.cachedWidth === width
    ) {
      return this.cachedLines;
    }

    if (!this.text || this.text.trim().length === 0) {
      this.cachedText = this.text;
      this.cachedWidth = width;
      this.cachedLines = [];
      return [];
    }

    const normalizedText = this.text.replace(TAB_PATTERN, "   ");
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const leftMargin = " ".repeat(this.paddingX);
    const rightMargin = " ".repeat(this.paddingX);

    const renderedLines = normalizedText.split("\n").map((line) => {
      const truncatedLine = truncateToWidth(line, contentWidth, "");
      const lineWithMargins = `${leftMargin}${truncatedLine}${rightMargin}`;
      const visLen = visibleWidth(lineWithMargins);
      const paddedLine = `${lineWithMargins}${" ".repeat(Math.max(0, width - visLen))}`;

      return this.backgroundEnabled
        ? this.backgroundFn(paddedLine)
        : paddedLine;
    });

    const result = ["", ...renderedLines];
    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = result;
    return result;
  }
}

export interface ToolRendererMap {
  [toolName: string]: (
    view: BaseToolCallView,
    input: unknown,
    output: unknown
  ) => void;
}

export class BaseToolCallView extends Container {
  private readonly callId: string;
  private readonly content: TrimmedMarkdown;
  private readonly markdownTheme: MarkdownTheme;
  private readonly renderers?: ToolRendererMap;
  private readonly showRawToolIo: boolean;
  private displayMode: "content" | "pretty" = "content";
  private error: unknown;
  private finalInput: unknown;
  private inputBuffer = "";
  private output: unknown;
  private outputDenied = false;
  private parsedInput: unknown;
  private prettyBlockActive = false;
  private readBlock: Container | null = null;
  private readBody: BackgroundBody | null = null;
  private readHeader: TrimmedMarkdown | null = null;
  private renderedOverride: string | null = null;
  private toolName: string;

  constructor(
    callId: string,
    toolName: string,
    markdownTheme: MarkdownTheme,
    _requestRender?: () => void,
    showRawToolIo?: boolean,
    renderers?: ToolRendererMap
  ) {
    super();
    this.callId = callId;
    this.toolName = toolName;
    this.markdownTheme = markdownTheme;
    this.showRawToolIo = showRawToolIo ?? false;
    this.renderers = renderers;
    this.content = new TrimmedMarkdown("", 1, 0, markdownTheme);
    this.addChild(this.content);
    this.refresh();
  }

  dispose(): void {
    return;
  }

  async appendInputChunk(chunk: string): Promise<void> {
    this.inputBuffer += chunk;
    const { value, state } = await parsePartialJson(this.inputBuffer);
    // Suppress transient empty objects during partial parsing to prevent
    // renderers from briefly showing "(unknown)" headers before real data arrives.
    if (state !== "successful-parse" && isPlainEmptyObject(value)) {
      return;
    }
    this.parsedInput = value;
    this.refresh();
  }

  setError(error: unknown): void {
    this.error = error;
    this.refresh();
  }

  setFinalInput(input: unknown): void {
    this.finalInput = input;
    this.refresh();
  }

  setOutput(output: unknown): void {
    this.output = output;
    this.refresh();
  }

  setOutputDenied(): void {
    this.outputDenied = true;
    this.refresh();
  }

  setToolName(toolName: string): void {
    this.toolName = toolName;
    this.refresh();
  }

  setRenderedOverride(markdown: string): void {
    this.renderedOverride = markdown;
  }

  getError(): unknown {
    return this.error;
  }

  isOutputDenied(): boolean {
    return this.outputDenied;
  }

  /**
   * Public API for custom tool renderers. Sets a pretty block with Markdown
   * header and ANSI-backgrounded body. See TUI README for usage examples.
   */
  setPrettyBlock(
    header: string,
    body: string,
    options?: {
      isPending?: boolean;
      isError?: boolean;
      useBackground?: boolean;
    }
  ): void {
    this.prettyBlockActive = true;
    this.ensurePrettyBlockComponents();

    if (!(this.readBody && this.readHeader && this.readBlock)) {
      return;
    }

    this.setDisplayMode("pretty");

    if (options?.isError) {
      this.readBody.setBackground(applyErrorBackground);
    } else {
      this.readBody.setBackground(applyGrayBackground);
    }

    this.readBody.setBackgroundEnabled(options?.useBackground ?? true);
    this.readHeader.setText(header);
    this.readBody.setText(body);
  }

  private ensurePrettyBlockComponents(): void {
    if (this.readBlock) {
      return;
    }

    const header = new TrimmedMarkdown("", 1, 0, this.markdownTheme);
    const body = new BackgroundBody("", 1, applyGrayBackground);
    const block = new Container();
    block.addChild(header);
    block.addChild(body as unknown as InstanceType<typeof Container>);

    this.readHeader = header;
    this.readBody = body;
    this.readBlock = block;
  }

  private setDisplayMode(mode: "content" | "pretty"): void {
    if (this.displayMode === mode) {
      return;
    }
    this.displayMode = mode;
    this.clear();
    if (mode === "pretty" && this.readBlock) {
      this.addChild(this.readBlock);
    } else {
      this.addChild(this.content);
    }
  }

  private resolveBestInput(): unknown {
    if (this.finalInput !== undefined) {
      return this.finalInput;
    }

    if (this.parsedInput !== undefined) {
      return this.parsedInput;
    }

    if (this.inputBuffer.length > 0) {
      return this.inputBuffer;
    }

    return;
  }

  private tryRenderWithCustomRenderer(bestInput: unknown): boolean {
    if (this.outputDenied) {
      return false;
    }

    const renderer = this.renderers?.[this.toolName];
    if (!renderer) {
      return false;
    }

    this.renderedOverride = null;
    this.prettyBlockActive = false;
    renderer(this, bestInput, this.output);
    return this.renderedOverride !== null || this.prettyBlockActive;
  }

  private shouldSuppressRawFallback(): boolean {
    if (this.showRawToolIo) {
      return false;
    }

    return (
      this.finalInput === undefined &&
      this.output === undefined &&
      this.error === undefined &&
      !this.outputDenied &&
      this.inputBuffer.length > 0
    );
  }

  private refresh(): void {
    const bestInput = this.resolveBestInput();

    if (!this.showRawToolIo && this.tryRenderWithCustomRenderer(bestInput)) {
      if (this.prettyBlockActive) {
        return;
      }
      if (this.renderedOverride) {
        this.setDisplayMode("content");
        this.content.setText(this.renderedOverride);
        return;
      }
    }

    this.setDisplayMode("content");

    if (this.shouldSuppressRawFallback()) {
      return;
    }

    const resolvedToolName = this.toolName || UNKNOWN_TOOL_NAME;
    const blocks: string[] = [
      `**Tool** \`${resolvedToolName}\` (\`${this.callId}\`)`,
    ];

    if (bestInput !== undefined) {
      blocks.push(`**Input**\n\n${renderCodeBlock("json", bestInput)}`);
    }

    if (this.output !== undefined) {
      blocks.push(`**Output**\n\n${renderCodeBlock("text", this.output)}`);
    }

    if (this.error !== undefined) {
      blocks.push(`**Error**\n\n${renderCodeBlock("text", this.error)}`);
    }

    if (this.outputDenied) {
      blocks.push("**Output** denied by model/policy");
    }

    this.content.setText(blocks.join("\n\n"));
  }
}

export type ToolCallView = BaseToolCallView;
