import {
  MANUAL_TOOL_LOOP_MAX_STEPS,
  shouldContinueManualToolLoop,
} from "./tool-loop-control";
import type {
  AgentFinishReason,
  LoopContinueContext,
  RunAgentLoopOptions,
  RunAgentLoopResult,
} from "./types";

export async function runAgentLoop(
  options: RunAgentLoopOptions
): Promise<RunAgentLoopResult> {
  const { agent, abortSignal, onError, onStepComplete, onToolCall } = options;
  const shouldContinue = options.shouldContinue ?? shouldContinueManualToolLoop;
  const maxIterations = options.maxIterations ?? MANUAL_TOOL_LOOP_MAX_STEPS;
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

      if (!shouldContinue(lastFinishReason, context)) {
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
