import type { ModelMessage } from "ai";

export interface ToolApprovalContext {
  id?: string;
  reason?: string;
  required?: boolean;
  state?: "approved" | "denied" | "pending";
}

export interface AgentExecutionContext {
  metadata?: Record<string, unknown>;
  modelId?: string;
  sessionId?: string;
  skills?: string[];
  toolApproval?: ToolApprovalContext;
}

export interface ToolSourceCallContext {
  abortSignal?: AbortSignal;
  experimentalContext?: AgentExecutionContext;
  messages: ModelMessage[];
  toolCallId: string;
  toolName: string;
}
