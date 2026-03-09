import type { AgentStreamResult, ModelMessage } from "@ai-sdk-tool/harness";
import type { TrajectoryEvent } from "./types";

export const extractToolOutput = (
  output: unknown
): { stdout: string; error?: string; exitCode?: number } => {
  if (typeof output === "object" && output !== null && "output" in output) {
    const result = output as {
      output: string;
      error?: string;
      exit_code?: number;
    };
    return {
      stdout: result.output || "",
      error: result.error,
      exitCode: result.exit_code,
    };
  }
  return { stdout: String(output) };
};

export const getToolInputChunk = (part: {
  delta?: unknown;
  inputTextDelta?: unknown;
}): string | null => {
  if (typeof part.delta === "string") {
    return part.delta;
  }

  if (typeof part.inputTextDelta === "string") {
    return part.inputTextDelta;
  }

  return null;
};

export const getToolInputId = (part: {
  id?: string;
  toolCallId?: string;
}): string | undefined => part.id ?? part.toolCallId;

export interface PendingToolCall {
  arguments: string;
  id: string;
}

export const handleToolInputStart = (
  pendingToolCalls: Map<string, PendingToolCall>,
  part: {
    id?: string;
    toolCallId?: string;
  }
): void => {
  const id = getToolInputId(part);
  if (!id) {
    return;
  }

  pendingToolCalls.set(id, {
    id,
    arguments: "",
  });
};

export const handleToolInputDelta = (
  pendingToolCalls: Map<string, PendingToolCall>,
  part: {
    delta?: unknown;
    id?: string;
    inputTextDelta?: unknown;
    toolCallId?: string;
  }
): void => {
  const toolCallId = getToolInputId(part);
  const toolCallDelta = getToolInputChunk(part);

  if (!toolCallId || toolCallDelta === null) {
    return;
  }

  const existing = pendingToolCalls.get(toolCallId);
  if (existing) {
    existing.arguments += toolCallDelta;
    return;
  }

  pendingToolCalls.set(toolCallId, {
    id: toolCallId,
    arguments: toolCallDelta,
  });
};

export const emitToolCallEvent = (
  emitEvent: (event: TrajectoryEvent) => void,
  sessionId: string,
  completedToolCallIds: Set<string>,
  modelId: string,
  reasoningContent: string,
  part: {
    input: unknown;
    toolCallId: string;
    toolName: string;
  }
): string => {
  completedToolCallIds.add(part.toolCallId);
  emitEvent({
    timestamp: new Date().toISOString(),
    type: "tool_call",
    sessionId,
    tool_call_id: part.toolCallId,
    tool_name: part.toolName,
    tool_input: part.input as Record<string, unknown>,
    model: modelId,
    reasoning_content: reasoningContent || undefined,
  });
  return "";
};

export const emitToolResultEvent = (
  emitEvent: (event: TrajectoryEvent) => void,
  sessionId: string,
  part: {
    output: unknown;
    toolCallId: string;
  }
): void => {
  const toolOutput = extractToolOutput(part.output);
  emitEvent({
    timestamp: new Date().toISOString(),
    type: "tool_result",
    sessionId,
    tool_call_id: part.toolCallId,
    output: toolOutput.stdout,
    error: toolOutput.error,
    exit_code: toolOutput.exitCode,
  });
};

export const emitToolErrorEvent = (
  emitEvent: (event: TrajectoryEvent) => void,
  sessionId: string,
  part: {
    error: unknown;
    toolCallId: string;
  }
): void => {
  emitEvent({
    timestamp: new Date().toISOString(),
    type: "tool_result",
    sessionId,
    tool_call_id: part.toolCallId,
    output: "",
    error:
      part.error instanceof Error ? part.error.message : String(part.error),
    exit_code: 1,
  });
};

export const emitMalformedToolCallErrors = (
  emitEvent: (event: TrajectoryEvent) => void,
  sessionId: string,
  completedToolCallIds: Set<string>,
  pendingToolCalls: Map<string, PendingToolCall>
): void => {
  for (const [id, pending] of pendingToolCalls) {
    if (completedToolCallIds.has(id)) {
      continue;
    }

    emitEvent({
      timestamp: new Date().toISOString(),
      type: "error",
      sessionId,
      error: `Tool call failed: malformed JSON in tool arguments (id: ${id}). Raw arguments: ${pending.arguments.slice(0, 500)}`,
    });
  }
};

export const emitMalformedToolCallsSummary = (
  emitEvent: (event: TrajectoryEvent) => void,
  sessionId: string,
  completedToolCallIds: Set<string>,
  lastFinishReason: string | undefined,
  pendingToolCalls: Map<string, PendingToolCall>
): void => {
  if (
    lastFinishReason !== "tool-calls" ||
    pendingToolCalls.size === 0 ||
    completedToolCallIds.size > 0
  ) {
    return;
  }

  emitEvent({
    timestamp: new Date().toISOString(),
    type: "error",
    sessionId,
    error:
      "Model attempted tool calls but all failed due to malformed JSON. This is likely a model bug with JSON escaping in tool arguments.",
  });
};

export interface ProcessStreamOptions {
  emitEvent: (event: TrajectoryEvent) => void;
  modelId: string;
  onMessages: (messages: ModelMessage[]) => void;
  sessionId: string;
  shouldContinue: (finishReason: string) => boolean;
  stream: AgentStreamResult;
}

export interface ProcessStreamResult {
  currentReasoning: string;
  currentText: string;
  shouldContinue: boolean;
}

const STREAM_RESPONSE_TIMEOUT_MS = 30_000;

export const processStream = async (
  opts: ProcessStreamOptions
): Promise<ProcessStreamResult> => {
  const { stream, sessionId, modelId, emitEvent, shouldContinue, onMessages } =
    opts;

  let currentText = "";
  let currentReasoning = "";
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const completedToolCallIds = new Set<string>();
  let lastFinishReason: string | undefined;

  for await (const part of stream.fullStream) {
    switch (part.type) {
      case "text-delta":
        currentText += part.text;
        break;
      case "reasoning-delta":
        currentReasoning += part.text;
        break;
      case "tool-input-start":
        handleToolInputStart(pendingToolCalls, part);
        break;
      case "tool-input-delta":
        handleToolInputDelta(pendingToolCalls, part);
        break;
      case "tool-input-end":
        break;
      case "tool-call":
        currentReasoning = emitToolCallEvent(
          emitEvent,
          sessionId,
          completedToolCallIds,
          modelId,
          currentReasoning,
          part
        );
        break;
      case "tool-result":
        emitToolResultEvent(emitEvent, sessionId, part);
        break;
      case "tool-error":
        emitToolErrorEvent(emitEvent, sessionId, part);
        break;
      case "finish-step": {
        const finishPart = part as Extract<
          typeof part,
          { type: "finish-step" }
        >;
        lastFinishReason = finishPart.finishReason;
        break;
      }
      default:
        break;
    }
  }

  emitMalformedToolCallErrors(
    emitEvent,
    sessionId,
    completedToolCallIds,
    pendingToolCalls
  );
  emitMalformedToolCallsSummary(
    emitEvent,
    sessionId,
    completedToolCallIds,
    lastFinishReason,
    pendingToolCalls
  );

  try {
    const [response, finishReason] = await Promise.race([
      Promise.all([stream.response, stream.finishReason]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Stream response timeout")),
          STREAM_RESPONSE_TIMEOUT_MS
        )
      ),
    ]);
    onMessages(response.messages);

    if (currentText.trim()) {
      emitEvent({
        timestamp: new Date().toISOString(),
        type: "assistant",
        sessionId,
        content: currentText,
        model: modelId,
        reasoning_content: currentReasoning || undefined,
      });
    }

    pendingToolCalls.clear();
    completedToolCallIds.clear();

    return {
      shouldContinue: shouldContinue(finishReason),
      currentText,
      currentReasoning,
    };
  } catch (error) {
    emitEvent({
      timestamp: new Date().toISOString(),
      type: "error",
      sessionId,
      error: String(error),
    });

    return {
      shouldContinue: true,
      currentText,
      currentReasoning,
    };
  }
};
