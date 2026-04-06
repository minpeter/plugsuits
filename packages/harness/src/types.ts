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

import type { MCPManager } from "./mcp-manager.js";
import type { MCPServerConfig } from "./mcp-types.js";

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
  | boolean
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
  instructions?: AgentInstructions;
  maxStepsPerTurn?: number;
  /** Optional MCP (Model Context Protocol) configuration. When provided, MCP tools are loaded and merged with local tools at agent creation time. */
  mcp?: MCPOption;
  model: LanguageModel;
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
  maxOutputTokens?: StreamTextOptions["maxOutputTokens"];
  messages: ModelMessage[];
  providerOptions?: StreamTextOptions["providerOptions"];
  seed?: StreamTextOptions["seed"];
  system?: string;
  temperature?: StreamTextOptions["temperature"];
}

/** Result of a single streaming turn from {@link Agent.stream}. */
export interface AgentStreamResult {
  finishReason: CoreStreamResult["finishReason"];
  fullStream: CoreStreamResult["fullStream"];
  response: CoreStreamResult["response"];
  /** Aggregated token usage across all steps in this turn. */
  totalUsage: CoreStreamResult["totalUsage"];
  /** Token usage for this turn (last step). Resolves after streaming completes. */
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
  onError?: (
    error: unknown,
    context: LoopContinueContext
  ) => void | Promise<void>;
  onStepComplete?: (step: LoopStepInfo) => void | Promise<void>;
  onToolCall?: (
    call: ToolCallPart,
    context: LoopContinueContext
  ) => void | Promise<void>;
  shouldContinue?: (
    finishReason: AgentFinishReason,
    context: LoopContinueContext
  ) => boolean;
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
