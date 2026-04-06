/**
 * @module agent
 * Core agent factory for the harness package.
 */

import { stepCountIs, streamText } from "ai";
import type {
  Agent,
  AgentConfig,
  AgentStreamOptions,
  AgentStreamResult,
} from "./types";

/**
 * Creates an {@link Agent} instance that wraps a Vercel AI SDK `streamText` call.
 *
 * @param config - Agent configuration including model, tools, and instructions.
 * @returns An `Agent` object with a `stream()` method for initiating a single turn.
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   model: openai('gpt-4o'),
 *   instructions: 'You are a helpful assistant.',
 *   tools: { get_time: tool({ ... }) },
 * });
 * ```
 */
export function createAgent(config: AgentConfig): Agent {
  return {
    config,
    /**
     * Initiates a single streaming turn with the given messages.
     * Returns a result object with `fullStream`, `finishReason`, and `response`.
     */
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
        seed: opts.seed,
        stopWhen: stepCountIs(config.maxStepsPerTurn ?? 1),
        temperature: opts.temperature,
        abortSignal: opts.abortSignal,
        experimental_repairToolCall: config.experimental_repairToolCall,
      });

      const finishReason = result.finishReason;
      const response = result.response;
      const usage = result.usage;
      const totalUsage = result.totalUsage;

      const swallow = () => undefined;
      finishReason.then(undefined, swallow);
      response.then(undefined, swallow);
      usage.then(undefined, swallow);
      totalUsage.then(undefined, swallow);

      return {
        finishReason,
        fullStream: result.fullStream,
        response,
        usage,
        totalUsage,
      };
    },
  };
}
