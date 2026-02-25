import { stepCountIs, streamText } from "ai";
import type {
  Agent,
  AgentConfig,
  AgentStreamOptions,
  AgentStreamResult,
} from "./types";

export function createAgent(config: AgentConfig): Agent {
  return {
    config,
    stream(opts: AgentStreamOptions): AgentStreamResult {
      const system =
        opts.system ??
        (typeof config.instructions === "string"
          ? config.instructions
          : undefined);

      const result = streamText({
        model: config.model,
        tools: config.tools,
        system,
        messages: opts.messages,
        providerOptions: opts.providerOptions,
        maxOutputTokens: opts.maxOutputTokens,
        stopWhen: stepCountIs(config.maxStepsPerTurn ?? 1),
        abortSignal: opts.abortSignal,
      });

      return {
        finishReason: result.finishReason,
        fullStream: result.fullStream,
        response: result.response,
      };
    },
  };
}
