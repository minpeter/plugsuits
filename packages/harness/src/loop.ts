/**
 * @module loop
 * Agent execution loop for the harness package.
 */

import { AgentError, AgentErrorCode } from "./errors";
import {
  composeStopPredicates,
  shouldContinueManualToolLoop,
} from "./tool-loop-control";
import { getToolLifecycleState } from "./tool-stream-parts";
import type {
  AgentFinishReason,
  AgentStreamOptions,
  LoopContinueContext,
  RunAgentLoopOptions,
  RunAgentLoopResult,
} from "./types";

async function invokeObserverHook(
  hook: ((context: LoopContinueContext) => void | Promise<void>) | undefined,
  hookName: string,
  context: LoopContinueContext
): Promise<void> {
  if (!hook) {
    return;
  }
  try {
    await hook(context);
  } catch (error) {
    console.error(`[harness] ${hookName} threw; continuing stream:`, error);
  }
}

/**
 * Runs an {@link Agent} in a loop until a stop condition is met or `maxIterations` is reached.
 *
 * The loop continues as long as `shouldContinue` returns `true` (default: continues on
 * `tool-calls` finish reasons). Each iteration streams a full agent turn,
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
  const {
    agent,
    abortSignal,
    onError,
    onFirstStreamPart,
    onInterrupt,
    onStepComplete,
    onStreamStart,
    onToolCall,
    onToolLifecycle,
  } = options;
  let shouldContinue: (
    finishReason: AgentFinishReason,
    context: LoopContinueContext
  ) => boolean = (finishReason) => shouldContinueManualToolLoop(finishReason);
  if (Array.isArray(options.shouldContinue)) {
    shouldContinue = composeStopPredicates<
      AgentFinishReason,
      LoopContinueContext
    >(shouldContinueManualToolLoop, ...options.shouldContinue);
  } else if (options.shouldContinue) {
    shouldContinue = composeStopPredicates<
      AgentFinishReason,
      LoopContinueContext
    >(shouldContinueManualToolLoop, options.shouldContinue);
  }
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const messages = [...options.messages];

  let iteration = 0;
  let lastFinishReason: AgentFinishReason = "stop";

  while (iteration < maxIterations) {
    if (abortSignal?.aborted) {
      const context: LoopContinueContext = { iteration, messages };
      await onInterrupt?.({ iteration, reason: "abort-signal" }, context);
      break;
    }

    const context: LoopContinueContext = { iteration, messages };
    const pendingApprovalToolCalls = new Set<string>();

    try {
      const instructions = agent.config.instructions;
      const system =
        typeof instructions === "function"
          ? await instructions()
          : instructions;
      const preparedStepOverrides = await options.onPrepareStep?.(context);
      const turnOverrides = await options.onBeforeTurn?.(context);
      const streamOptions: AgentStreamOptions = {
        messages,
        abortSignal,
        system,
        ...preparedStepOverrides,
        ...turnOverrides,
      };

      const stream = agent.stream(streamOptions);

      await invokeObserverHook(onStreamStart, "onStreamStart", context);

      let firstPartSeen = false;

      for await (const part of stream.fullStream) {
        if (!firstPartSeen) {
          firstPartSeen = true;
          await invokeObserverHook(
            onFirstStreamPart,
            "onFirstStreamPart",
            context
          );
        }

        const lifecycle = getToolLifecycleState(
          part as { toolCallId?: string; toolName?: string; type: string }
        );
        if (lifecycle) {
          const resolvedLifecycle = { ...lifecycle };

          if (resolvedLifecycle.approvalState === "pending") {
            if (resolvedLifecycle.toolCallId) {
              pendingApprovalToolCalls.add(resolvedLifecycle.toolCallId);
            }
          } else if (
            resolvedLifecycle.toolCallId &&
            pendingApprovalToolCalls.has(resolvedLifecycle.toolCallId)
          ) {
            if (resolvedLifecycle.state === "tool-call") {
              resolvedLifecycle.approvalState = "approved";
              pendingApprovalToolCalls.delete(resolvedLifecycle.toolCallId);
            }

            if (resolvedLifecycle.state === "output-denied") {
              resolvedLifecycle.approvalState = "denied";
              pendingApprovalToolCalls.delete(resolvedLifecycle.toolCallId);
            }
          }

          await onToolLifecycle?.(resolvedLifecycle, context);
        }

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

      if (!shouldContinue(lastFinishReason, { iteration, messages })) {
        iteration += 1;
        break;
      }

      iteration += 1;
    } catch (error) {
      if (abortSignal?.aborted) {
        await onInterrupt?.({ iteration, reason: "abort-signal" }, context);
        break;
      }

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

  if (
    iteration >= maxIterations &&
    shouldContinue(lastFinishReason, { iteration: iteration - 1, messages })
  ) {
    throw new AgentError(
      AgentErrorCode.MAX_ITERATIONS,
      `Agent loop exceeded maximum iterations: ${maxIterations}`
    );
  }

  return {
    messages,
    iterations: iteration,
    finishReason: lastFinishReason,
  };
}
