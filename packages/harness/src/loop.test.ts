import { describe, expect, it } from "vitest";
import { runAgentLoop } from "./loop";
import type { Agent, AgentStreamResult } from "./types";

/**
 * Creates a mock agent that simulates streaming behavior.
 * Each call to stream() advances through the provided finish reasons.
 */
function createMockAgent(
  finishReasons: string[],
  options?: {
    toolCallsPerIteration?: Array<
      Array<{ toolName: string; args: Record<string, unknown> }>
    >;
  }
): Agent {
  let callIndex = 0;

  return {
    config: {
      model: {} as Agent["config"]["model"],
    },
    stream(): AgentStreamResult {
      const currentIndex = callIndex;
      callIndex++;

      const finishReason = finishReasons[currentIndex] ?? "stop";
      const toolCallsForThisIteration =
        options?.toolCallsPerIteration?.[currentIndex] ?? [];

      // Simulate async iterator for fullStream
      async function* fullStreamGenerator() {
        for (const call of toolCallsForThisIteration) {
          await Promise.resolve();
          yield {
            type: "tool-call" as const,
            toolName: call.toolName,
            args: call.args,
            toolCallId: `call_${currentIndex}_${call.toolName}`,
          };
        }
      }

      const fullStream = fullStreamGenerator();

      const response = {
        messages: [
          {
            role: "assistant" as const,
            content: `Response ${currentIndex}`,
          },
        ],
      };

      return {
        fullStream,
        finishReason: Promise.resolve(finishReason),
        response: Promise.resolve(
          response as unknown as Awaited<AgentStreamResult["response"]>
        ),
      };
    },
  };
}

describe("runAgentLoop", () => {
  it("stops when finish reason is 'stop'", async () => {
    const agent = createMockAgent(["stop"]);

    const result = await runAgentLoop({
      agent,
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.iterations).toBe(1);
    expect(result.finishReason).toBe("stop");
  });

  it("continues when finish reason is 'tool-calls'", async () => {
    const agent = createMockAgent(["tool-calls", "stop"]);

    const result = await runAgentLoop({
      agent,
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.iterations).toBe(2);
    expect(result.finishReason).toBe("stop");
  });

  it("respects maxIterations limit", async () => {
    // Agent would loop forever with 'tool-calls'
    const agent = createMockAgent([
      "tool-calls",
      "tool-calls",
      "tool-calls",
      "tool-calls",
      "tool-calls",
    ]);

    const result = await runAgentLoop({
      agent,
      messages: [{ role: "user", content: "Hello" }],
      maxIterations: 3,
    });

    expect(result.iterations).toBe(3);
  });

  it("default maxIterations is Infinity (loops until stop condition)", async () => {
    // Simulate an agent that makes many tool calls before stopping
    // Without explicit maxIterations, this should run until the agent stops naturally
    const manyToolCalls = new Array(1000).fill("tool-calls");
    manyToolCalls.push("stop"); // Eventually stops

    const agent = createMockAgent(manyToolCalls);

    const result = await runAgentLoop({
      agent,
      messages: [{ role: "user", content: "Hello" }],
    });

    // If default was finite (like 200), this would fail
    expect(result.iterations).toBe(1001); // 1000 tool-calls + 1 stop
    expect(result.finishReason).toBe("stop");
  });

  it("stops when shouldContinue returns false", async () => {
    const agent = createMockAgent(["tool-calls", "tool-calls", "tool-calls"]);

    // Messages are always appended BEFORE checking shouldContinue
    // Loop: iteration 0 → append → iteration=1 → shouldContinue(0) → true
    // Loop: iteration 1 → append → iteration=2 → shouldContinue(1) → true
    // Loop: iteration 2 → append → iteration=3 → shouldContinue(2) → false → break
    const result = await runAgentLoop({
      agent,
      messages: [{ role: "user", content: "Hello" }],
      shouldContinue: (_reason, context) => {
        return context.iteration < 2;
      },
    });

    expect(result.iterations).toBe(3);
  });

  it("stops on abort signal", async () => {
    const agent = createMockAgent([
      "tool-calls",
      "tool-calls",
      "tool-calls",
      "tool-calls",
      "tool-calls",
    ]);

    const controller = new AbortController();

    // Abort after first iteration completes
    const result = await runAgentLoop({
      agent,
      messages: [{ role: "user", content: "Hello" }],
      abortSignal: controller.signal,
      onStepComplete: () => {
        controller.abort();
      },
    });

    expect(result.iterations).toBe(1);
  });

  it("accumulates messages from each iteration", async () => {
    const agent = createMockAgent(["tool-calls", "stop"]);

    const result = await runAgentLoop({
      agent,
      messages: [{ role: "user", content: "Hello" }],
    });

    // Initial message + response from iteration 0 + response from iteration 1
    // Both responses are always appended before checking continuation
    expect(result.messages.length).toBe(3);
  });

  it("calls onToolCall for each tool call", async () => {
    const agent = createMockAgent(["tool-calls", "stop"], {
      toolCallsPerIteration: [
        // Only first iteration has tool calls
        [
          { toolName: "get_time", args: {} },
          { toolName: "get_weather", args: { location: "Paris" } },
        ],
        // Second iteration has no tool calls (finish reason is 'stop')
        [],
      ],
    });

    const toolCalls: Array<{ toolName: string }> = [];

    await runAgentLoop({
      agent,
      messages: [{ role: "user", content: "Hello" }],
      onToolCall: (call) => {
        toolCalls.push({ toolName: call.toolName });
      },
    });

    expect(toolCalls.length).toBe(2);
    expect(toolCalls[0].toolName).toBe("get_time");
    expect(toolCalls[1].toolName).toBe("get_weather");
  });
});
