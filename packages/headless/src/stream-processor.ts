import type { AgentStreamResult, ModelMessage } from "@ai-sdk-tool/harness";
import type {
  AgentStepEvent,
  ErrorEvent,
  ObservationResult,
  StepMetrics,
  ToolCallData,
  TrajectoryEvent,
} from "./types";

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
  input?: unknown;
  toolName?: string;
}

export interface PendingToolResult {
  content: string;
  sourceCallId: string;
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

export const upsertCompletedToolCall = (
  pendingToolCalls: Map<string, PendingToolCall>,
  part: {
    input?: unknown;
    toolCallId: string;
    toolName: string;
  }
): void => {
  const existing = pendingToolCalls.get(part.toolCallId);
  if (existing) {
    existing.toolName = part.toolName;
    existing.input = part.input;
    return;
  }

  pendingToolCalls.set(part.toolCallId, {
    id: part.toolCallId,
    arguments: "",
    input: part.input,
    toolName: part.toolName,
  });
};

export const bufferedToolCallData = (
  pendingToolCalls: Map<string, PendingToolCall>,
  completedToolCallIds: Set<string>
): ToolCallData[] | undefined => {
  const result: ToolCallData[] = [];
  for (const [id, pending] of pendingToolCalls) {
    if (!completedToolCallIds.has(id)) {
      continue;
    }
    const args = pending.input ?? parseToolArguments(pending.arguments);
    if (args) {
      result.push({
        tool_call_id: id,
        function_name: pending.toolName ?? "",
        arguments: args as Record<string, unknown>,
      });
    }
  }
  return result.length > 0 ? result : undefined;
};

const parseToolArguments = (
  argumentsStr: string
): Record<string, unknown> | null => {
  try {
    return JSON.parse(argumentsStr) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const emitMalformedToolCallErrors = (
  emitEvent: (event: TrajectoryEvent) => void,
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
      error: `Tool call failed: malformed JSON in tool arguments (id: ${id}). Raw arguments: ${pending.arguments.slice(0, 500)}`,
    });
  }
};

export const emitMalformedToolCallsSummary = (
  emitEvent: (event: TrajectoryEvent) => void,
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
    error:
      "Model attempted tool calls but all failed due to malformed JSON. This is likely a model bug with JSON escaping in tool arguments.",
  });
};

export interface ProcessStreamOptions {
  emitEvent: (event: TrajectoryEvent) => void;
  modelId: string;
  onMessages: (messages: ModelMessage[]) => void;
  shouldContinue: (finishReason: string) => boolean;
  stepId: number;
  stream: AgentStreamResult;
}

export interface ProcessStreamResult {
  currentReasoning: string;
  currentText: string;
  shouldContinue: boolean;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
}

const STREAM_RESPONSE_TIMEOUT_MS = 30_000;

export const processStream = async (
  opts: ProcessStreamOptions
): Promise<ProcessStreamResult> => {
  const { stream, stepId, modelId, emitEvent, shouldContinue, onMessages } =
    opts;

  let currentText = "";
  let currentReasoning = "";
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const completedToolCallIds = new Set<string>();
  const observationResults: ObservationResult[] = [];
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
      case "tool-call": {
        const callPart = part as Extract<typeof part, { type: "tool-call" }>;
        completedToolCallIds.add(callPart.toolCallId);
        upsertCompletedToolCall(pendingToolCalls, callPart);
        break;
      }
      case "tool-result": {
        const resultPart = part as Extract<
          typeof part,
          { type: "tool-result" }
        >;
        const toolOutput = extractToolOutput(resultPart.output);
        observationResults.push({
          source_call_id: resultPart.toolCallId,
          content: JSON.stringify({
            stdout: toolOutput.stdout,
            error: toolOutput.error,
            exit_code: toolOutput.exitCode,
          }),
        });
        break;
      }
      case "tool-error": {
        const errorPart = part as Extract<typeof part, { type: "tool-error" }>;
        const errorMsg =
          errorPart.error instanceof Error
            ? errorPart.error.message
            : String(errorPart.error);
        observationResults.push({
          source_call_id: errorPart.toolCallId,
          content: JSON.stringify({ error: errorMsg, exit_code: 1 }),
        });
        break;
      }
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
    completedToolCallIds,
    pendingToolCalls
  );
  emitMalformedToolCallsSummary(
    emitEvent,
    completedToolCallIds,
    lastFinishReason,
    pendingToolCalls
  );

  try {
    let timeoutId: ReturnType<typeof setTimeout>;
    const [response, finishReason, usage] = await Promise.race([
      Promise.all([stream.response, stream.finishReason, stream.usage]).finally(
        () => {
          clearTimeout(timeoutId);
        }
      ),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Stream response timeout")),
          STREAM_RESPONSE_TIMEOUT_MS
        );
      }),
    ]);
    onMessages(response.messages);

    const agentStepEvent: AgentStepEvent = {
      type: "step",
      step_id: stepId,
      timestamp: new Date().toISOString(),
      source: "agent",
      message: currentText || "(no text output)",
      model_name: modelId,
      reasoning_content: currentReasoning || undefined,
      tool_calls: bufferedToolCallData(pendingToolCalls, completedToolCallIds),
      observation: observationResults.length
        ? { results: observationResults }
        : undefined,
      metrics: usage
        ? ({
            prompt_tokens:
              usage.inputTokens ??
              (usage as Record<string, unknown>).promptTokens,
            completion_tokens:
              usage.outputTokens ??
              (usage as Record<string, unknown>).completionTokens,
            cached_tokens:
              (usage as Record<string, unknown>).cachedTokens ?? undefined,
            cost_usd: (usage as Record<string, unknown>).costUsd ?? undefined,
          } as StepMetrics)
        : undefined,
    };

    emitEvent(agentStepEvent);

    pendingToolCalls.clear();
    completedToolCallIds.clear();

    return {
      shouldContinue: shouldContinue(finishReason),
      currentText,
      currentReasoning,
      usage: usage ?? null,
    };
  } catch (error) {
    const errorEvent: ErrorEvent = {
      timestamp: new Date().toISOString(),
      type: "error",
      error: String(error),
    };
    emitEvent(errorEvent);

    return {
      shouldContinue: false,
      currentText,
      currentReasoning,
      usage: null,
    };
  }
};
