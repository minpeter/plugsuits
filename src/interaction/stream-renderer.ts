import type { Writable } from "node:stream";
import type { TextStreamPart, ToolSet } from "ai";
import { env } from "../env";
import { colorize, colors } from "./colors";

export interface StreamRenderOptions {
  output?: Writable;
  showReasoning?: boolean;
  showSteps?: boolean;
  showFinishReason?: boolean;
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
  _ctx: RenderContext,
  _part: Extract<StreamPart, { type: "tool-approval-request" }>
): StreamMode => {
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

export interface StreamRenderResult {
  approvalRequests: ToolApprovalRequestPart[];
}

export const renderFullStream = async <TOOLS extends ToolSet>(
  stream: AsyncIterable<TextStreamPart<TOOLS>>,
  options: StreamRenderOptions = {}
): Promise<StreamRenderResult> => {
  const ctx: RenderContext = {
    output: options.output ?? process.stdout,
    showReasoning: options.showReasoning ?? true,
    showSteps: options.showSteps ?? false,
    showFinishReason: options.showFinishReason ?? env.DEBUG_SHOW_FINISH_REASON,
    showSources: options.showSources ?? true,
    showFiles: options.showFiles ?? true,
    useColor: options.useColor ?? Boolean(process.stdout.isTTY),
  };

  let mode: StreamMode = "none";
  const approvalRequests: ToolApprovalRequestPart[] = [];

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
        mode = handleToolApprovalRequest(ctx, part);
        approvalRequests.push(part);
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

  return { approvalRequests };
};
