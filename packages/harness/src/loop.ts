/**
 * @module loop
 * Agent execution loop for the harness package.
 */

import { shouldContinueManualToolLoop } from "./tool-loop-control";
import type {
  AgentFinishReason,
  LoopContinueContext,
  RunAgentLoopOptions,
  RunAgentLoopResult,
} from "./types";

/**
 * Runs an {@link Agent} in a loop until a stop condition is met or `maxIterations` is reached.
 *
 * The loop continues as long as `shouldContinue` returns `true` (default: continues on
 * `tool-calls` and `unknown` finish reasons). Each iteration streams a full agent turn,
 * collects tool calls, and appends response messages to the conversation history.
 *
 * @param options - Loop configuration including agent, messages, hooks, and limits.
 * @returns A promise resolving to the final messages, iteration count, and finish reason.
 *
 * @example
 * ```typescript
 * const result = await runAgentLoop({
 *   agent,
 *   messages: [{ role: 'user', content: 'Hello!' }],
 *   maxIterations: 20,
 *   onToolCall: (call, ctx) => console.log(call.toolName),
 * });
 * ```
 */
export async function runAgentLoop(
  options: RunAgentLoopOptions
): Promise<RunAgentLoopResult> {
  const { agent, abortSignal, onError, onStepComplete, onToolCall } = options;
  const shouldContinue = options.shouldContinue ?? shouldContinueManualToolLoop;
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const messages = [...options.messages];

  let iteration = 0;
  let lastFinishReason: AgentFinishReason = "stop";

  while (iteration < maxIterations) {
    if (abortSignal?.aborted) {
      break;
    }

    const context: LoopContinueContext = { iteration, messages };

    try {
      const instructions = agent.config.instructions;
      const system =
        typeof instructions === "function"
          ? await instructions()
          : instructions;

      const stream = agent.stream({ messages, abortSignal, system });

      for await (const part of stream.fullStream) {
        if (part.type === "tool-call") {
          await onToolCall?.(part, context);
        }
      }

      const [response, finishReason] = await Promise.all([
        stream.response,
        stream.finishReason,
      ]);

      messages.push(...response.messages);
      lastFinishReason = finishReason;

      await onStepComplete?.({
        finishReason: lastFinishReason,
        iteration,
        messages,
        response,
      });

      iteration += 1;

      if (!shouldContinue(lastFinishReason, { iteration, messages })) {
        break;
      }
    } catch (error) {
      await onError?.(error, context);
      throw error;
    }
  }

  return {
    messages,
    iterations: iteration,
    finishReason: lastFinishReason,
  };
}
