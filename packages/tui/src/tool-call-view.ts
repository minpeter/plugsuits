import { Container, Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";
import { parsePartialJson } from "ai";

const UNKNOWN_TOOL_NAME = "tool";
const TRAILING_NEWLINES = /\n+$/;

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
  return `\`\`\`${language}\n${text}\n\`\`\``;
};

export interface ToolRendererMap {
  [toolName: string]: (
    view: BaseToolCallView,
    input: unknown,
    output: unknown
  ) => void;
}

export class BaseToolCallView extends Container {
  private readonly callId: string;
  private readonly content: Markdown;
  private readonly renderers?: ToolRendererMap;
  private error: unknown;
  private finalInput: unknown;
  private inputBuffer = "";
  private output: unknown;
  private outputDenied = false;
  private parsedInput: unknown;
  private renderedOverride: string | null = null;
  private toolName: string;

  constructor(
    callId: string,
    toolName: string,
    markdownTheme: MarkdownTheme,
    _requestRender?: () => void,
    _showRawToolIo?: boolean,
    renderers?: ToolRendererMap
  ) {
    super();
    this.callId = callId;
    this.toolName = toolName;
    this.renderers = renderers;
    this.content = new Markdown("", 1, 0, markdownTheme);
    this.addChild(this.content);
    this.refresh();
  }

  dispose(): void {
    return;
  }

  async appendInputChunk(chunk: string): Promise<void> {
    this.inputBuffer += chunk;
    const { value } = await parsePartialJson(this.inputBuffer);
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

  setRenderedMarkdown(markdown: string): void {
    this.renderedOverride = markdown;
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

    return undefined;
  }

  private tryRenderWithCustomRenderer(bestInput: unknown): boolean {
    if (
      this.output === undefined ||
      this.outputDenied ||
      this.error !== undefined
    ) {
      return false;
    }

    const renderer = this.renderers?.[this.toolName];
    if (!renderer) {
      return false;
    }

    this.renderedOverride = null;
    renderer(this, bestInput, this.output);
    return this.renderedOverride !== null;
  }

  private refresh(): void {
    const bestInput = this.resolveBestInput();
    if (this.tryRenderWithCustomRenderer(bestInput) && this.renderedOverride) {
      this.content.setText(this.renderedOverride);
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
