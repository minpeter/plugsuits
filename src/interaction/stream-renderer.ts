import type { Writable } from "node:stream";
import type { TextStreamPart, ToolSet } from "ai";
import { colorize, colors } from "./colors";

export interface StreamRenderOptions {
  output?: Writable;
  showReasoning?: boolean;
  showToolInput?: boolean;
  showSteps?: boolean;
  showFinishReason?: boolean;
  showSources?: boolean;
  showFiles?: boolean;
  useColor?: boolean;
}

type StreamMode = "text" | "reasoning" | "tool-input" | "none";

interface RenderContext {
  output: Writable;
  showReasoning: boolean;
  showToolInput: boolean;
  showSteps: boolean;
  showFinishReason: boolean;
  showSources: boolean;
  showFiles: boolean;
  useColor: boolean;
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
  return applyColor(ctx, "cyan", label);
};

const renderToolLabel = (ctx: RenderContext): string => {
  return applyColor(ctx, "green", "tool");
};

const renderErrorLabel = (ctx: RenderContext): string => {
  return applyColor(ctx, "red", "error");
};

const renderReasoningPrefix = (ctx: RenderContext): string => {
  if (!ctx.useColor) {
    return "[reasoning] ";
  }

  return `${colors.dim}${colors.cyan}[reasoning] `;
};

const renderReasoningEnd = (ctx: RenderContext): string => {
  return ctx.useColor ? colors.reset : "";
};

const handleTextStart = (ctx: RenderContext, mode: StreamMode): StreamMode => {
  if (mode !== "text") {
    writeLine(ctx);
    write(ctx, `${applyColor(ctx, "yellow", "AI")}: `);
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
    write(ctx, `${applyColor(ctx, "yellow", "AI")}: `);
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

const handleReasoningStart = (ctx: RenderContext): StreamMode => {
  if (!ctx.showReasoning) {
    return "none";
  }
  writeLine(ctx);
  write(ctx, renderReasoningPrefix(ctx));
  return "reasoning";
};

const handleReasoningDelta = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "reasoning-delta" }>
): StreamMode => {
  if (!ctx.showReasoning) {
    return "none";
  }
  write(ctx, part.text);
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

const handleToolInputStart = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "tool-input-start" }>
): StreamMode => {
  if (!ctx.showToolInput) {
    return "none";
  }
  writeLine(ctx);
  writeLine(ctx, `${renderToolLabel(ctx)} ${part.toolName} (${part.id})`);
  return "tool-input";
};

const handleToolInputDelta = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "tool-input-delta" }>
): StreamMode => {
  if (!ctx.showToolInput) {
    return "none";
  }
  write(ctx, part.delta);
  return "tool-input";
};

const handleToolInputEnd = (ctx: RenderContext): StreamMode => {
  if (!ctx.showToolInput) {
    return "none";
  }
  writeLine(ctx);
  return "none";
};

const handleToolCall = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "tool-call" }>
): StreamMode => {
  writeLine(ctx);
  writeLine(
    ctx,
    `${renderToolLabel(ctx)} ${part.toolName} (${part.toolCallId})`
  );
  writeLine(ctx, formatBlock(part.input));
  return "none";
};

const handleToolResult = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "tool-result" }>
): StreamMode => {
  writeLine(ctx);
  writeLine(
    ctx,
    `${renderToolLabel(ctx)} ${part.toolName} (${part.toolCallId})`
  );
  writeLine(ctx, formatBlock(part.output));
  return "none";
};

const handleToolError = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "tool-error" }>
): StreamMode => {
  writeLine(ctx);
  writeLine(
    ctx,
    `${renderErrorLabel(ctx)} ${part.toolName} (${part.toolCallId})`
  );
  writeLine(ctx, formatBlock(part.error));
  return "none";
};

const handleToolOutputDenied = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "tool-output-denied" }>
): StreamMode => {
  writeLine(ctx);
  writeLine(
    ctx,
    `${renderToolLabel(ctx)} output denied ${part.toolName} (${part.toolCallId})`
  );
  return "none";
};

const handleToolApprovalRequest = (
  ctx: RenderContext,
  part: Extract<StreamPart, { type: "tool-approval-request" }>
): StreamMode => {
  writeLine(ctx);
  writeLine(
    ctx,
    `${renderToolLabel(ctx)} approval ${part.toolCall.toolName} (${part.toolCall.toolCallId})`
  );
  writeLine(ctx, formatBlock(part.toolCall.input));
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

export const renderFullStream = async <TOOLS extends ToolSet>(
  stream: AsyncIterable<TextStreamPart<TOOLS>>,
  options: StreamRenderOptions = {}
): Promise<void> => {
  const ctx: RenderContext = {
    output: options.output ?? process.stdout,
    showReasoning: options.showReasoning ?? true,
    showToolInput: options.showToolInput ?? true,
    showSteps: options.showSteps ?? false,
    showFinishReason: options.showFinishReason ?? true,
    showSources: options.showSources ?? true,
    showFiles: options.showFiles ?? true,
    useColor: options.useColor ?? Boolean(process.stdout.isTTY),
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
        mode = handleToolInputStart(ctx, part);
        break;
      case "tool-input-delta":
        mode = handleToolInputDelta(ctx, part);
        break;
      case "tool-input-end":
        mode = handleToolInputEnd(ctx);
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
        mode = handleToolApprovalRequest(ctx, part);
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
