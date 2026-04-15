import {
  type AgentStreamResult,
  getToolLifecycleState,
  type ModelMessage,
  getToolInputChunk as sharedGetToolInputChunk,
  getToolInputId as sharedGetToolInputId,
} from "@ai-sdk-tool/harness";
import type {
  ApprovalEvent,
  AgentStepEvent,
  ErrorEvent,
  ObservationResult,
  StepMetrics,
  ToolCallData,
  TrajectoryEvent,
} from "./types";

export const extractToolOutput = (output: unknown): string => {
  if (typeof output === "string") {
    return output;
  }
  if (output === null || output === undefined) {
    return "";
  }
  if (typeof output === "object" && "output" in output) {
    const inner = (output as Record<string, unknown>).output;
    if (typeof inner === "string") {
      return inner;
    }
    return safeStringify(inner);
  }
  return safeStringify(output);
};

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}

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

const fallbackGetToolInputId = (part: {
  id?: string;
  toolCallId?: string;
}): string | undefined => {
  return part.id ?? part.toolCallId;
};

const fallbackGetToolInputChunk = (part: {
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

const getToolInputId =
  typeof sharedGetToolInputId === "function"
    ? sharedGetToolInputId
    : fallbackGetToolInputId;

const getToolInputChunk =
  typeof sharedGetToolInputChunk === "function"
    ? sharedGetToolInputChunk
    : fallbackGetToolInputChunk;

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

interface ApprovalTransitionHandlerParams {
  emitEvent: (event: TrajectoryEvent) => void;
  pendingApprovalToolCalls: Set<string>;
}

const emitApprovalTransition = (
  emitEvent: (event: TrajectoryEvent) => void,
  event: ApprovalEvent
): void => {
  emitEvent(event);
};

const handleApprovalRequested = (
  part: Extract<
    { type: "tool-approval-request" },
    { type: "tool-approval-request" }
  > & {
    providerExecuted?: boolean;
    reason?: string;
    toolCallId?: string;
    toolName?: string;
  },
  params: ApprovalTransitionHandlerParams
): void => {
  const lifecycle = getToolLifecycleState(part);
  if (lifecycle?.state !== "approval-requested") {
    return;
  }

  const approvalEvent: ApprovalEvent = {
    type: "approval",
    state: "pending",
    timestamp: new Date().toISOString(),
    toolCallId: lifecycle.toolCallId,
    toolName: lifecycle.toolName,
    reason: part.reason,
    providerExecuted: part.providerExecuted,
  };

  if (lifecycle.toolCallId) {
    params.pendingApprovalToolCalls.add(lifecycle.toolCallId);
  }

  emitApprovalTransition(params.emitEvent, approvalEvent);
};

const handleApprovalResolvedByToolCall = (
  part: Extract<{ type: "tool-call" }, { type: "tool-call" }> & {
    toolCallId: string;
    toolName: string;
  },
  params: ApprovalTransitionHandlerParams
): void => {
  if (!params.pendingApprovalToolCalls.has(part.toolCallId)) {
    return;
  }

  emitApprovalTransition(params.emitEvent, {
    type: "approval",
    state: "approved",
    timestamp: new Date().toISOString(),
    toolCallId: part.toolCallId,
    toolName: part.toolName,
  });
  params.pendingApprovalToolCalls.delete(part.toolCallId);
};

const handleApprovalResolvedByDenial = (
  part: Extract<
    { type: "tool-output-denied" },
    { type: "tool-output-denied" }
  > & {
    toolCallId: string;
    toolName: string;
  },
  params: ApprovalTransitionHandlerParams
): void => {
  if (!params.pendingApprovalToolCalls.has(part.toolCallId)) {
    return;
  }

  emitApprovalTransition(params.emitEvent, {
    type: "approval",
    state: "denied",
    timestamp: new Date().toISOString(),
    toolCallId: part.toolCallId,
    toolName: part.toolName,
  });
  params.pendingApprovalToolCalls.delete(part.toolCallId);
};

export interface ProcessStreamOptions {
  emitEvent: (event: TrajectoryEvent) => void;
  modelId: string;
  onMessages: (messages: ModelMessage[]) => void;
  shouldContinue: (finishReason: string) => boolean;
  stepId: number;
  stream: AgentStreamResult;
  streamTimeoutMs?: number;
}

export interface ProcessStreamResult {
  currentReasoning: string;
  currentText: string;
  finishReason?: string;
  shouldContinue: boolean;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
}

export const processStream = async (
  opts: ProcessStreamOptions
): Promise<ProcessStreamResult> => {
  const {
    stream,
    stepId,
    modelId,
    emitEvent,
    shouldContinue,
    onMessages,
    streamTimeoutMs = 30_000,
  } = opts;

  let currentText = "";
  let currentReasoning = "";
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const pendingApprovalToolCalls = new Set<string>();
  const completedToolCallIds = new Set<string>();
  const observationResults: ObservationResult[] = [];
  let lastFinishReason: string | undefined;
  const approvalParams: ApprovalTransitionHandlerParams = {
    emitEvent,
    pendingApprovalToolCalls,
  };

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
        handleApprovalResolvedByToolCall(callPart, approvalParams);
        completedToolCallIds.add(callPart.toolCallId);
        upsertCompletedToolCall(pendingToolCalls, callPart);
        break;
      }
      case "tool-result": {
        const resultPart = part as Extract<
          typeof part,
          { type: "tool-result" }
        >;
        observationResults.push({
          source_call_id: resultPart.toolCallId,
          content: extractToolOutput(resultPart.output),
        });
        break;
      }
      case "tool-error": {
        const errorPart = part as Extract<typeof part, { type: "tool-error" }>;
        pendingApprovalToolCalls.delete(errorPart.toolCallId);
        const errorMsg =
          errorPart.error instanceof Error
            ? errorPart.error.message
            : String(errorPart.error);
        observationResults.push({
          source_call_id: errorPart.toolCallId,
          content: errorMsg,
        });
        break;
      }
      case "tool-approval-request": {
        handleApprovalRequested(
          part as Extract<typeof part, { type: "tool-approval-request" }> & {
            providerExecuted?: boolean;
            reason?: string;
            toolCallId?: string;
            toolName?: string;
          },
          approvalParams
        );
        break;
      }
      case "tool-output-denied": {
        handleApprovalResolvedByDenial(
          part as Extract<typeof part, { type: "tool-output-denied" }> & {
            toolCallId: string;
            toolName: string;
          },
          approvalParams
        );
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
          () =>
            reject(
              new Error(`Stream response timeout after ${streamTimeoutMs}ms`)
            ),
          streamTimeoutMs
        );
      }),
    ]);
    onMessages(response.messages);

    const agentStepEvent: AgentStepEvent = {
      type: "step",
      step_id: stepId,
      timestamp: new Date().toISOString(),
      source: "agent",
      message: currentText,
      model_name: modelId,
      reasoning_content: currentReasoning || undefined,
      tool_calls: bufferedToolCallData(pendingToolCalls, completedToolCallIds),
      observation: observationResults.length
        ? { results: observationResults }
        : undefined,
      metrics: usage
        ? ({
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
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
      finishReason,
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
      finishReason: lastFinishReason,
      shouldContinue: false,
      currentText,
      currentReasoning,
      usage: null,
    };
  }
};
