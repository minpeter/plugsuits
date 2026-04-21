export interface ToolInputDeltaPartLike {
  delta?: unknown;
  id?: string;
  inputTextDelta?: unknown;
  toolCallId?: string;
}

export interface ToolInputPartLike {
  id?: string;
  toolCallId?: string;
}

export interface ToolLifecyclePartLike extends ToolInputPartLike {
  toolName?: string;
  type: string;
}

export interface ToolLifecycleState {
  approvalState?: "approved" | "denied" | "pending";
  state:
    | "approval-requested"
    | "error"
    | "input-streaming"
    | "output-denied"
    | "result"
    | "tool-call";
  toolCallId?: string;
  toolName?: string;
}

export const getToolInputId = (part: ToolInputPartLike): string | undefined =>
  part.id ?? part.toolCallId;

export const getToolInputChunk = (
  part: ToolInputDeltaPartLike
): string | null => {
  if (typeof part.delta === "string") {
    return part.delta;
  }

  if (typeof part.inputTextDelta === "string") {
    return part.inputTextDelta;
  }

  return null;
};

export const getToolLifecycleState = (
  part: ToolLifecyclePartLike
): ToolLifecycleState | null => {
  const toolCallId = getToolInputId(part);

  switch (part.type) {
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-input-end":
      return {
        state: "input-streaming",
        toolCallId,
        toolName: part.toolName,
      };
    case "tool-call":
      return {
        state: "tool-call",
        toolCallId,
        toolName: part.toolName,
      };
    case "tool-result":
      return {
        state: "result",
        toolCallId,
        toolName: part.toolName,
      };
    case "tool-error":
      return {
        state: "error",
        toolCallId,
        toolName: part.toolName,
      };
    case "tool-output-denied":
      return {
        approvalState: "denied",
        state: "output-denied",
        toolCallId,
        toolName: part.toolName,
      };
    case "tool-approval-request":
      return {
        approvalState: "pending",
        state: "approval-requested",
        toolCallId,
        toolName: part.toolName,
      };
    default:
      return null;
  }
};
