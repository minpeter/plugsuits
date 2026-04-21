import type { BeforeTurnResult } from "@ai-sdk-tool/harness";

/**
 * ATIF-v1.6 native event types for trajectory logging.
 *
 * All emitted step events (UserStepEvent, AgentStepEvent) conform to the ATIF specification.
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
 * Union of all step event types.
 */
export type StepEvent = UserStepEvent | AgentStepEvent;

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
  code?: string;
  error: string;
  timestamp: string;
  type: "error";
}

export interface ApprovalEvent {
  providerExecuted?: boolean;
  reason?: string;
  state: "approved" | "denied" | "pending";
  timestamp: string;
  toolCallId?: string;
  toolName?: string;
  type: "approval";
}

export interface InterruptEvent {
  reason: "caller-abort";
  timestamp: string;
  type: "interrupt";
}

/**
 * Emitted immediately after the agent's LLM request is dispatched but before
 * any stream chunk has arrived. Consumers can use this as a "prompt
 * processing started" signal to render a loading indicator. Lifecycle
 * annotation — carries no `step_id`.
 */
export interface TurnStartEvent {
  phase: "new-turn" | "intermediate-step";
  timestamp: string;
  type: "turn-start";
}

export type { HistorySnapshot } from "@ai-sdk-tool/harness";

export interface HeadlessRunnerConfig {
  abortSignal?: AbortSignal;
  agent: import("@ai-sdk-tool/harness").RunnableAgent;
  atifOutputPath?: string;
  circuitBreaker?: import("@ai-sdk-tool/harness").CompactionCircuitBreaker;
  compactionCallbacks?: import("@ai-sdk-tool/harness").CompactionOrchestratorCallbacks;
  disableCompaction?: boolean;
  emitEvent?: (event: TrajectoryEvent) => void;
  initialUserMessage?: {
    content: string;
    eventContent?: string;
    originalContent?: string;
  };
  /**
   * Global iteration budget across all agent turns, including TODO reminder iterations.
   * Prefer maxTodoReminders when you only want to cap reminder follow-ups.
   */
  maxIterations?: number;
  maxTodoReminders?: number;
  measureUsage?: (
    messages: import("@ai-sdk-tool/harness").ModelMessage[]
  ) => Promise<import("@ai-sdk-tool/harness").UsageMeasurement | null>;
  messageHistory: import("@ai-sdk-tool/harness").CheckpointHistory;
  modelId: string;
  onBeforeTurn?: (
    phase: "new-turn" | "intermediate-step"
  ) => BeforeTurnResult | Promise<BeforeTurnResult | undefined> | undefined;
  onInterrupt?: (event: InterruptEvent) => Promise<void> | void;
  onStreamStart?: (
    phase: "new-turn" | "intermediate-step"
  ) => void | Promise<void>;
  onTodoReminder?: () => Promise<{
    hasReminder: boolean;
    message: string | null;
  }>;
  onTurnComplete?: (
    messages: import("@ai-sdk-tool/harness").CheckpointMessage[],
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    },
    snapshot?: import("@ai-sdk-tool/harness").HistorySnapshot,
    finishReason?: string
  ) => Promise<void> | void;
  sessionId: string;
  shouldContinue?: (finishReason: string) => boolean;
  streamTimeoutMs?: number;
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
  | ApprovalEvent
  | InterruptEvent
  | MetadataEvent
  | TurnStartEvent;
