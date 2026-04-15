/**
 * @module types
 * Shared TypeScript types for the harness package.
 */

import type {
  LanguageModel,
  ModelMessage,
  streamText,
  ToolCallPart,
  ToolSet,
} from "ai";

import type { StopCondition } from "./agent";
import type { AgentExecutionContext } from "./execution-context";
import type { MCPManager } from "./mcp-manager";
import type { MCPServerConfig } from "./mcp-types";
import type { StopPredicate } from "./tool-loop-control";
import type { ToolSource } from "./tool-source";
import type { ToolLifecycleState } from "./tool-stream-parts";

export type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  Tool,
  ToolCallPart,
  ToolSet,
} from "ai";

type CoreStreamResult = ReturnType<typeof streamText>;
type StreamTextOptions = Parameters<typeof streamText>[0];

export type AgentInstructions = string | (() => Promise<string>);

export interface AgentGuardrails {
  maxToolCallsPerTurn?: number;
  repeatedToolCallThreshold?: number;
}

/**
 * Options for configuring MCP (Model Context Protocol) client integration.
 * Passed to {@link AgentConfig.mcp} to enable automatic MCP tool loading.
 *
 * @example `mcp: true` — load from .mcp.json
 * @example `mcp: [{ url: "https://..." }]` — inline servers
 * @example `mcp: { config: true, servers: [...] }` — both
 * @example `mcp: mcpManager` — pre-initialized instance (lifecycle managed by caller)
 */
export type MCPOption =
  | true
  | MCPServerConfig[]
  | {
      config?: boolean | string;
      onError?: (server: string, error: unknown) => void;
      servers?: MCPServerConfig[];
      toolsTimeout?: number;
    }
  | MCPManager;

/** Configuration for creating an agent via {@link createAgent}. */
export interface AgentConfig {
  experimental_repairToolCall?: StreamTextOptions["experimental_repairToolCall"];
  extraStopConditions?: StopCondition[];
  guardrails?: AgentGuardrails;
  instructions?: AgentInstructions;
  maxStepsPerTurn?: number;
  /** Optional MCP (Model Context Protocol) configuration. When provided, MCP tools are loaded and merged with local tools at agent creation time. */
  mcp?: MCPOption;
  model: LanguageModel;
  prepareStep?: (
    context: AgentPrepareStepContext
  ) => AgentPrepareStepResult | undefined;
  streamDefaults?: AgentStreamDefaults;
  toolSources?: ToolSource[];
  tools?: ToolSet;
}

/** An agent instance returned by {@link createAgent}. */
export interface Agent {
  /** Release MCP connections and resources. Safe to call multiple times (idempotent). No-op if no MCP was configured. */
  close(): Promise<void>;
  config: AgentConfig;
  stream(opts: AgentStreamOptions): AgentStreamResult;
}

/** Shared runtime stream surface consumed by shell packages. */
export interface RunnableAgent {
  stream(
    opts: AgentStreamOptions
  ): AgentStreamResult | Promise<AgentStreamResult>;
}

/** Options passed to {@link Agent.stream} for a single turn. */
export interface AgentStreamOptions {
  abortSignal?: AbortSignal;
  experimentalContext?: AgentExecutionContext;
  maxOutputTokens?: StreamTextOptions["maxOutputTokens"];
  messages: ModelMessage[];
  providerOptions?: StreamTextOptions["providerOptions"];
  seed?: StreamTextOptions["seed"];
  system?: string;
  temperature?: StreamTextOptions["temperature"];
}

export interface BeforeTurnResult extends Partial<AgentStreamOptions> {}

export interface AgentStreamDefaults
  extends Omit<Partial<AgentStreamOptions>, "abortSignal" | "messages"> {}

export interface AgentPrepareStepContext extends AgentStreamOptions {
  model: LanguageModel;
}

export interface AgentPrepareStepResult extends Partial<AgentStreamOptions> {}

/** Result of a single streaming turn from {@link Agent.stream}. */
export interface AgentStreamResult {
  /** Promise resolving to the finish reason. Await: `const reason = await result.finishReason` */
  finishReason: CoreStreamResult["finishReason"];
  fullStream: CoreStreamResult["fullStream"];
  /** Promise resolving to the full response. Await: `const res = await result.response` */
  response: CoreStreamResult["response"];
  /** Promise resolving to aggregated token usage across all steps in this turn. Await: `const total = await result.totalUsage` */
  totalUsage: CoreStreamResult["totalUsage"];
  /** Promise resolving to per-step token usage. Await: `const usage = await result.usage` */
  usage: CoreStreamResult["usage"];
}

export type AgentFinishReason = Awaited<AgentStreamResult["finishReason"]>;

/** Context passed to loop hooks during each iteration. */
export interface LoopContinueContext {
  iteration: number;
  messages: ModelMessage[];
}

/** Information about a completed loop step, passed to `onStepComplete`. */
export interface LoopStepInfo {
  finishReason: Awaited<AgentStreamResult["finishReason"]>;
  iteration: number;
  messages: ModelMessage[];
  response: Awaited<AgentStreamResult["response"]>;
}

/** Lifecycle hooks for {@link runAgentLoop}. */
export interface LoopHooks {
  onBeforeTurn?: (
    context: LoopContinueContext
  ) => BeforeTurnResult | Promise<BeforeTurnResult | undefined> | undefined;
  onError?: (
    error: unknown,
    context: LoopContinueContext
  ) =>
    | void
    | Promise<void>
    | { shouldContinue?: boolean; recovery?: ModelMessage[] }
    | Promise<
        { shouldContinue?: boolean; recovery?: ModelMessage[] } | undefined
      >;
  onInterrupt?: (
    interruption: {
      iteration: number;
      reason: "abort-signal";
    },
    context: LoopContinueContext
  ) => void | Promise<void>;
  onPrepareStep?: (
    context: LoopContinueContext
  ) => BeforeTurnResult | Promise<BeforeTurnResult | undefined> | undefined;
  onStepComplete?: (step: LoopStepInfo) => void | Promise<void>;
  onToolLifecycle?: (
    lifecycle: ToolLifecycleState,
    context: LoopContinueContext
  ) => void | Promise<void>;
  onToolCall?: (
    call: ToolCallPart,
    context: LoopContinueContext
  ) => void | Promise<void>;
  shouldContinue?:
    | StopPredicate<AgentFinishReason, LoopContinueContext>
    | StopPredicate<AgentFinishReason, LoopContinueContext>[];
}

/** Options for {@link runAgentLoop}. */
export interface RunAgentLoopOptions extends LoopHooks {
  abortSignal?: AbortSignal;
  agent: Agent;
  maxIterations?: number;
  messages: ModelMessage[];
}

/** Result returned by {@link runAgentLoop} after the loop completes. */
export interface RunAgentLoopResult {
  finishReason: AgentFinishReason;
  iterations: number;
  messages: ModelMessage[];
}
