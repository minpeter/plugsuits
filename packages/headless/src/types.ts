/**
 * ATIF-v1.6 native event types for trajectory logging.
 *
 * All step events (UserStepEvent, AgentStepEvent, SystemStepEvent) conform to the ATIF specification.
 * Metadata is emitted once at run start. Compaction and error events are lifecycle annotations.
 */

// ============================================================================
// Sub-types
// ============================================================================

/**
 * Represents a single tool call invocation.
 */
export interface ToolCallData {
  arguments: Record<string, unknown>;
  function_name: string;
  tool_call_id: string;
}

/**
 * Represents a single observation result from a tool call.
 */
export interface ObservationResult {
  content: string;
  source_call_id: string;
}

/**
 * Container for observation results from tool calls.
 */
export interface ObservationData {
  results: ObservationResult[];
}

/**
 * Token usage metrics from the agent's model invocation.
 * All fields come from the SDK's stream.usage and are never estimated.
 */
export interface StepMetrics {
  cached_tokens?: number;
  completion_tokens?: number;
  cost_usd?: number;
  prompt_tokens?: number;
}

// ============================================================================
// ATIF Step Events
// ============================================================================

/**
 * A user message step.
 */
export interface UserStepEvent {
  message: string;
  source: "user";
  step_id: number;
  timestamp: string;
  type: "step";
}

/**
 * An agent response step with optional reasoning, tool calls, and observations.
 */
export interface AgentStepEvent {
  message: string;
  metrics?: StepMetrics;
  model_name?: string;
  observation?: ObservationData;
  reasoning_content?: string;
  source: "agent";
  step_id: number;
  timestamp: string;
  tool_calls?: ToolCallData[];
  type: "step";
}

/**
 * A system message step, typically containing observations.
 */
export interface SystemStepEvent {
  message: string;
  observation?: ObservationData;
  source: "system";
  step_id: number;
  timestamp: string;
  type: "step";
}

/**
 * Union of all step event types.
 */
export type StepEvent = UserStepEvent | AgentStepEvent | SystemStepEvent;

// ============================================================================
// Lifecycle Events
// ============================================================================

/**
 * A compaction lifecycle event. Not an ATIF step (no step_id).
 * Tracks message history compaction operations.
 */
export interface CompactionEvent {
  blocking?: boolean;
  durationMs?: number;
  event: "start" | "complete" | "blocking_change";
  reason?: string;
  strategy?: string;
  timestamp: string;
  tokensAfter?: number;
  tokensBefore: number;
  type: "compaction";
}

/**
 * An error event for fatal or iteration-limit failures.
 */
export interface ErrorEvent {
  error: string;
  timestamp: string;
  type: "error";
}

/**
 * Metadata event emitted once at run start.
 * Contains session and agent information for the trajectory.
 */
export interface MetadataEvent {
  agent: {
    name: string;
    version: string;
    model_name: string;
  };
  session_id: string;
  timestamp: string;
  type: "metadata";
}

// ============================================================================
// Union Type
// ============================================================================

/**
 * The complete union of all trajectory event types.
 */
export type TrajectoryEvent =
  | StepEvent
  | CompactionEvent
  | ErrorEvent
  | MetadataEvent;
