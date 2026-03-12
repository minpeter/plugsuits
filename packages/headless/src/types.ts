export interface BaseEvent {
  sessionId: string;
  timestamp: string;
}

export interface UserEvent extends BaseEvent {
  content: string;
  type: "user";
}

export interface AssistantEvent extends BaseEvent {
  content: string;
  model: string;
  reasoning_content?: string;
  type: "assistant";
}

export interface ToolCallEvent extends BaseEvent {
  model: string;
  reasoning_content?: string;
  tool_call_id: string;
  tool_input: Record<string, unknown>;
  tool_name: string;
  type: "tool_call";
}

export interface ToolResultEvent extends BaseEvent {
  error?: string;
  exit_code?: number;
  output: string;
  tool_call_id: string;
  type: "tool_result";
}

export interface ErrorEvent extends BaseEvent {
  error: string;
  type: "error";
}

export type TrajectoryEvent =
  | UserEvent
  | AssistantEvent
  | ToolCallEvent
  | ToolResultEvent
  | ErrorEvent;
