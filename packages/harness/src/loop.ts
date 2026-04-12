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

      lastFinishReason = finishReason;

      // Always append response messages before checking continuation —
      // the final turn's messages must be captured in the returned history.
      messages.push(...response.messages);

      await onStepComplete?.({
        finishReason: lastFinishReason,
        iteration,
        messages,
        response,
      });

      iteration += 1;

      if (
        !shouldContinue(lastFinishReason, {
          iteration: iteration - 1,
          messages,
        })
      ) {
        break;
      }
    } catch (error) {
      const errorResult = await onError?.(error, context);

      // If onError returns void or undefined, re-throw
      if (!errorResult) {
        throw error;
      }

      // If onError returns an object with shouldContinue: true, optionally recover
      if (
        errorResult &&
        typeof errorResult === "object" &&
        "shouldContinue" in errorResult &&
        errorResult.shouldContinue === true
      ) {
        // Add recovery messages if provided
        if (errorResult.recovery && Array.isArray(errorResult.recovery)) {
          messages.push(...errorResult.recovery);
        }
        iteration += 1;
        continue;
      }

      // Default: re-throw
      throw error;
    }
  }

  return {
    messages,
    iterations: iteration,
    finishReason: lastFinishReason,
  };
}
