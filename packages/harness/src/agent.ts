/**
 * @module agent
 * Core agent factory for the harness package.
 */

import { stepCountIs, streamText } from "ai";
import { resolveMCPOption } from "./mcp-init";
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
 * const agent = await createAgent({
 *   model: openai('gpt-4o'),
 *   instructions: 'You are a helpful assistant.',
 *   tools: { get_time: tool({ ... }) },
 * });
 * ```
 */
export async function createAgent(config: AgentConfig): Promise<Agent> {
  let mergedTools = config.tools;
  let closeFn: () => Promise<void> = async () => undefined;

  if (config.mcp !== undefined) {
    const resolved = await resolveMCPOption(config.mcp, config.tools ?? {});
    mergedTools = resolved.tools;
    closeFn = resolved.close;
  }

  const effectiveConfig: AgentConfig =
    mergedTools !== config.tools ? { ...config, tools: mergedTools } : config;

  return {
    config: effectiveConfig,
    close: closeFn,
    /**
     * Initiates a single streaming turn with the given messages.
     * Returns a result object with `fullStream`, `finishReason`, and `response`.
     */
    stream(opts: AgentStreamOptions): AgentStreamResult {
      const system =
        opts.system ??
        (typeof effectiveConfig.instructions === "string"
          ? effectiveConfig.instructions
          : undefined);

      const result = streamText({
        model: effectiveConfig.model,
        tools: effectiveConfig.tools,
        system,
        messages: opts.messages,
        providerOptions: opts.providerOptions,
        maxOutputTokens: opts.maxOutputTokens,
        seed: opts.seed,
        stopWhen: stepCountIs(effectiveConfig.maxStepsPerTurn ?? 1),
        temperature: opts.temperature,
        abortSignal: opts.abortSignal,
        experimental_repairToolCall:
          effectiveConfig.experimental_repairToolCall,
      });

      const { finishReason, response, usage, totalUsage } = result;

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
