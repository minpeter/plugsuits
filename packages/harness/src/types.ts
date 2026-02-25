import type {
  LanguageModel,
  ModelMessage,
  streamText,
  Tool,
  ToolCallPart,
  ToolSet,
} from "ai";

type CoreStreamResult = ReturnType<typeof streamText>;

export type { LanguageModel, ModelMessage, Tool, ToolSet };

export type AgentInstructions = string | (() => Promise<string>);

export interface AgentConfig {
  instructions?: AgentInstructions;
  maxStepsPerTurn?: number;
  model: LanguageModel;
  tools?: ToolSet;
}

export interface Agent {
  config: AgentConfig;
  stream(opts: AgentStreamOptions): AgentStreamResult;
}

export interface AgentStreamOptions {
  abortSignal?: AbortSignal;
  messages: ModelMessage[];
  system?: string;
}

export interface AgentStreamResult {
  finishReason: CoreStreamResult["finishReason"];
  fullStream: CoreStreamResult["fullStream"];
  response: CoreStreamResult["response"];
}

export type AgentFinishReason = Awaited<AgentStreamResult["finishReason"]>;

export interface LoopContinueContext {
  iteration: number;
  messages: ModelMessage[];
}

export interface LoopStepInfo {
  finishReason: AgentStreamResult["finishReason"];
  iteration: number;
  messages: ModelMessage[];
  response: AgentStreamResult["response"];
}

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

export interface RunAgentLoopOptions extends LoopHooks {
  abortSignal?: AbortSignal;
  agent: Agent;
  maxIterations?: number;
  messages: ModelMessage[];
}

export interface RunAgentLoopResult {
  finishReason: string;
  iterations: number;
  messages: ModelMessage[];
}
