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

export type {
  LanguageModel,
  ModelMessage,
  Tool,
  ToolCallPart,
  ToolSet,
} from "ai";

type CoreStreamResult = ReturnType<typeof streamText>;
type StreamTextOptions = Parameters<typeof streamText>[0];

export type AgentInstructions = string | (() => Promise<string>);

/** Configuration for creating an agent via {@link createAgent}. */
export interface AgentConfig {
  experimental_repairToolCall?: StreamTextOptions["experimental_repairToolCall"];
  instructions?: AgentInstructions;
  maxStepsPerTurn?: number;
  model: LanguageModel;
  tools?: ToolSet;
}

/** An agent instance returned by {@link createAgent}. */
export interface Agent {
  config: AgentConfig;
  stream(opts: AgentStreamOptions): AgentStreamResult;
}

/** Options passed to {@link Agent.stream} for a single turn. */
export interface AgentStreamOptions {
  abortSignal?: AbortSignal;
  maxOutputTokens?: StreamTextOptions["maxOutputTokens"];
  messages: ModelMessage[];
  providerOptions?: StreamTextOptions["providerOptions"];
  system?: string;
}

/** Result of a single streaming turn from {@link Agent.stream}. */
export interface AgentStreamResult {
  finishReason: CoreStreamResult["finishReason"];
  fullStream: CoreStreamResult["fullStream"];
  response: CoreStreamResult["response"];
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
