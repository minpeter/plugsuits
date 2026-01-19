import type { Writable } from "node:stream";
import type { TextStreamPart, ToolSet } from "ai";
import { env } from "../env";
import { colorize, colors } from "./colors";

export interface StreamRenderOptions {
  output?: Writable;
  showReasoning?: boolean;
  showSteps?: boolean;
  showFinishReason?: boolean;
  showToolResults?: boolean;
  showSources?: boolean;
  showFiles?: boolean;
  useColor?: boolean;
}

type StreamMode = "text" | "reasoning" | "none";

interface RenderContext {
  output: Writable;
  showReasoning: boolean;
  showSteps: boolean;
  showFinishReason: boolean;
  showToolResults: boolean;
  showSources: boolean;
  showFiles: boolean;
  useColor: boolean;
  reasoningLineLength: number;
  terminalWidth: number;
}

type StreamPart = TextStreamPart<ToolSet>;

const formatBlock = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const write = (ctx: RenderContext, text: string): void => {
  ctx.output.write(text);
};

const writeLine = (ctx: RenderContext, text = ""): void => {
  ctx.output.write(`${text}\n`);
};

const applyColor = (
  ctx: RenderContext,
  color: keyof typeof colors,
  text: string
): string => {
  if (!ctx.useColor) {
    return text;
  }

  return colorize(color, text);
};

const renderLabel = (ctx: RenderContext, label: string): string => {
  return applyColor(ctx, "magenta", label);
};

const renderToolLabel = (ctx: RenderContext): string => {
  if (!ctx.useColor) {
    return "tool";
  }
  return `${colors.bold}${colors.brightGreen}tool${colors.reset}`;
};

const renderErrorLabel = (ctx: RenderContext): string => {
  if (!ctx.useColor) {
    return "error";
  }
  return `${colors.bold}${colors.red}error${colors.reset}`;
};

const renderReasoningPrefix = (ctx: RenderContext): string => {
  if (!ctx.useColor) {
    return "│ ";
  }

  return `${colors.dim}${colors.italic}${colors.gray}│ `;
};

const renderReasoningEnd = (ctx: RenderContext): string => {
  return ctx.useColor ? colors.reset : "";
};

const handleTextStart = (ctx: RenderContext, mode: StreamMode): StreamMode => {
  if (mode !== "text") {
    writeLine(ctx);
    const aiLabel = ctx.useColor
      ? `${colors.bold}${colors.brightCyan}AI${colors.reset}`
      : "AI";
    write(ctx, `${aiLabel}: `);
  }
  return "text";
};

const handleTextDelta = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "text-delta" }>,
  mode: StreamMode
): StreamMode => {
  if (mode !== "text") {
    writeLine(ctx);
    const aiLabel = ctx.useColor
      ? `${colors.bold}${colors.brightCyan}AI${colors.reset}`
      : "AI";
    write(ctx, `${aiLabel}: `);
  }
  write(ctx, part.text);
  return "text";
};

const handleTextEnd = (ctx: RenderContext, mode: StreamMode): StreamMode => {
  if (mode === "text") {
    writeLine(ctx);
  }
  return "none";
};

const REASONING_PREFIX_LENGTH = 2;

const handleReasoningStart = (ctx: RenderContext): StreamMode => {
  if (!ctx.showReasoning) {
    return "none";
  }
  writeLine(ctx);
  write(ctx, renderReasoningPrefix(ctx));
  ctx.reasoningLineLength = REASONING_PREFIX_LENGTH;
  return "reasoning";
};

const handleReasoningDelta = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "reasoning-delta" }>
): StreamMode => {
  if (!ctx.showReasoning) {
    return "none";
  }

  const prefix = renderReasoningPrefix(ctx);
  const colorSuffix = ctx.useColor
    ? `${colors.dim}${colors.italic}${colors.gray}`
    : "";
  const colorReset = ctx.useColor ? colors.reset : "";
  const maxWidth = ctx.terminalWidth - 6;

  for (const char of part.text) {
    if (char === "\n") {
      write(ctx, `${colorReset}\n${prefix}${colorSuffix}`);
      ctx.reasoningLineLength = REASONING_PREFIX_LENGTH;
    } else if (ctx.reasoningLineLength >= maxWidth) {
      write(ctx, `${colorReset}\n${prefix}${colorSuffix}${char}`);
      ctx.reasoningLineLength = REASONING_PREFIX_LENGTH + 1;
    } else {
      write(ctx, char);
      ctx.reasoningLineLength++;
    }
  }

  return "reasoning";
};

const handleReasoningEnd = (ctx: RenderContext): StreamMode => {
  if (!ctx.showReasoning) {
    return "none";
  }
  write(ctx, renderReasoningEnd(ctx));
  writeLine(ctx);
  return "none";
};

const handleToolCall = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "tool-call" }>
): StreamMode => {
  writeLine(ctx);
  const toolName = ctx.useColor
    ? `${colors.bold}${colors.brightYellow}${part.toolName}${colors.reset}`
    : part.toolName;
  const callId = ctx.useColor
    ? `${colors.dim}${colors.gray}(${part.toolCallId})${colors.reset}`
    : `(${part.toolCallId})`;
  writeLine(ctx, `${renderToolLabel(ctx)} ${toolName} ${callId}`);
  const inputLabel = ctx.useColor
    ? `${colors.cyan}input:${colors.reset}`
    : "input:";
  writeLine(ctx, `${inputLabel} ${formatBlock(part.input)}`);
  return "none";
};

const handleToolResult = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "tool-result" }>
): StreamMode => {
  if (!ctx.showToolResults) {
    return "none";
  }
  writeLine(ctx);
  const toolName = ctx.useColor
    ? `${colors.bold}${colors.brightYellow}${part.toolName}${colors.reset}`
    : part.toolName;
  const callId = ctx.useColor
    ? `${colors.dim}${colors.gray}(${part.toolCallId})${colors.reset}`
    : `(${part.toolCallId})`;
  const resultLabel = ctx.useColor
    ? `${colors.green}result${colors.reset}`
    : "result";
  writeLine(ctx, `${resultLabel} ${toolName} ${callId}`);
  const outputLabel = ctx.useColor
    ? `${colors.cyan}output:${colors.reset}`
    : "output:";
  writeLine(ctx, `${outputLabel} ${formatBlock(part.output)}`);
  return "none";
};

const handleToolError = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "tool-error" }>
): StreamMode => {
  writeLine(ctx);
  const toolName = ctx.useColor
    ? `${colors.bold}${colors.brightYellow}${part.toolName}${colors.reset}`
    : part.toolName;
  const callId = ctx.useColor
    ? `${colors.dim}${colors.gray}(${part.toolCallId})${colors.reset}`
    : `(${part.toolCallId})`;
  writeLine(ctx, `${renderErrorLabel(ctx)} ${toolName} ${callId}`);
  const errorLabel = ctx.useColor
    ? `${colors.red}message:${colors.reset}`
    : "message:";
  writeLine(ctx, `${errorLabel} ${formatBlock(part.error)}`);
  return "none";
};

const handleToolOutputDenied = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "tool-output-denied" }>
): StreamMode => {
  writeLine(ctx);
  const toolName = ctx.useColor
    ? `${colors.bold}${colors.brightYellow}${part.toolName}${colors.reset}`
    : part.toolName;
  const callId = ctx.useColor
    ? `${colors.dim}${colors.gray}(${part.toolCallId})${colors.reset}`
    : `(${part.toolCallId})`;
  const deniedLabel = ctx.useColor
    ? `${colors.bold}${colors.red}output denied${colors.reset}`
    : "output denied";
  writeLine(ctx, `${deniedLabel} ${toolName} ${callId}`);
  return "none";
};

const handleStartStep = (ctx: RenderContext): StreamMode => {
  if (!ctx.showSteps) {
    return "none";
  }
  writeLine(ctx);
  writeLine(ctx, renderLabel(ctx, "[step start]"));
  return "none";
};

const handleFinishStep = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "finish-step" }>
): StreamMode => {
  if (!ctx.showSteps) {
    return "none";
  }
  writeLine(ctx);
  writeLine(ctx, `${renderLabel(ctx, "[step finish]")} ${part.finishReason}`);
  return "none";
};

const handleSource = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "source" }>
): StreamMode => {
  if (!ctx.showSources) {
    return "none";
  }
  writeLine(ctx);
  writeLine(ctx, renderLabel(ctx, "[source]"));
  writeLine(ctx, formatBlock(part));
  return "none";
};

const handleFile = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "file" }>
): StreamMode => {
  if (!ctx.showFiles) {
    return "none";
  }
  writeLine(ctx);
  writeLine(ctx, renderLabel(ctx, "[file]"));
  writeLine(ctx, formatBlock(part.file));
  return "none";
};

const handleFinish = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "finish" }>
): StreamMode => {
  if (!ctx.showFinishReason) {
    return "none";
  }
  writeLine(ctx);
  writeLine(
    ctx,
    `${renderLabel(ctx, "[finish]")} ${part.finishReason ?? "unknown"}`
  );
  return "none";
};

export interface ToolApprovalRequestPart {
  type: "tool-approval-request";
  approvalId: string;
  toolCall: {
    toolName: string;
    toolCallId: string;
    input: unknown;
  };
}

export const renderFullStream = async <TOOLS extends ToolSet>(
  stream: AsyncIterable<TextStreamPart<TOOLS>>,
  options: StreamRenderOptions = {}
): Promise<void> => {
  const ctx: RenderContext = {
    output: options.output ?? process.stdout,
    showReasoning: options.showReasoning ?? true,
    showSteps: options.showSteps ?? false,
    showFinishReason: options.showFinishReason ?? env.DEBUG_SHOW_FINISH_REASON,
    showToolResults: options.showToolResults ?? env.DEBUG_SHOW_TOOL_RESULTS,
    showSources: options.showSources ?? true,
    showFiles: options.showFiles ?? true,
    useColor: options.useColor ?? Boolean(process.stdout.isTTY),
    reasoningLineLength: 0,
    terminalWidth: process.stdout.columns || 80,
  };

  let mode: StreamMode = "none";

  for await (const rawPart of stream) {
    const part = rawPart as StreamPart;
    switch (part.type) {
      case "text-start":
        mode = handleTextStart(ctx, mode);
        break;
      case "text-delta":
        mode = handleTextDelta(ctx, part, mode);
        break;
      case "text-end":
        mode = handleTextEnd(ctx, mode);
        break;
      case "reasoning-start":
        mode = handleReasoningStart(ctx);
        break;
      case "reasoning-delta":
        mode = handleReasoningDelta(ctx, part);
        break;
      case "reasoning-end":
        mode = handleReasoningEnd(ctx);
        break;
      case "tool-input-start":
      case "tool-input-delta":
      case "tool-input-end":
        break;
      case "tool-call":
        mode = handleToolCall(ctx, part);
        break;
      case "tool-result":
        mode = handleToolResult(ctx, part);
        break;
      case "tool-error":
        mode = handleToolError(ctx, part);
        break;
      case "tool-output-denied":
        mode = handleToolOutputDenied(ctx, part);
        break;
      case "tool-approval-request":
        break;
      case "start-step":
        mode = handleStartStep(ctx);
        break;
      case "finish-step":
        mode = handleFinishStep(ctx, part);
        break;
      case "source":
        mode = handleSource(ctx, part);
        break;
      case "file":
        mode = handleFile(ctx, part);
        break;
      case "start":
        mode = "none";
        break;
      case "finish":
        mode = handleFinish(ctx, part);
        break;
      default:
        writeLine(ctx);
        writeLine(ctx, renderLabel(ctx, "[unknown part]"));
        writeLine(ctx, formatBlock(part));
        mode = "none";
    }
  }
};
