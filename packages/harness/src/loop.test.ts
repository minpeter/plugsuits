import { describe, expect, it } from "vitest";
import { AgentError, AgentErrorCode } from "./errors";
import { runAgentLoop } from "./loop";
import type { Agent, AgentStreamResult } from "./types";

/**
 * Creates a mock agent that simulates streaming behavior.
 * Each call to stream() advances through the provided finish reasons.
 */
function createMockAgent(
  finishReasons: string[],
  options?: {
    throwOnIteration?: number;
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

      if (options?.throwOnIteration === currentIndex) {
        throw new Error(`boom-${currentIndex}`);
      }

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

  it("throws AgentError when maxIterations limit is exceeded", async () => {
    // Agent would loop forever with 'tool-calls'
    const agent = createMockAgent([
      "tool-calls",
      "tool-calls",
      "tool-calls",
      "tool-calls",
      "tool-calls",
    ]);

    await expect(
      runAgentLoop({
        agent,
        messages: [{ role: "user", content: "Hello" }],
        maxIterations: 3,
      })
    ).rejects.toBeInstanceOf(AgentError);

    await expect(
      runAgentLoop({
        agent: createMockAgent(["tool-calls", "tool-calls"]),
        messages: [{ role: "user", content: "Hello" }],
        maxIterations: 1,
      })
    ).rejects.toMatchObject({ code: AgentErrorCode.MAX_ITERATIONS });
  });

  it("does not throw when the final allowed iteration stops normally", async () => {
    await expect(
      runAgentLoop({
        agent: createMockAgent(["stop"]),
        messages: [{ role: "user", content: "Hello" }],
        maxIterations: 1,
      })
    ).resolves.toMatchObject({
      iterations: 1,
      finishReason: "stop",
    });
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

  it("supports composed shouldContinue predicates", async () => {
    const result = await runAgentLoop({
      agent: createMockAgent(["tool-calls", "tool-calls", "tool-calls"]),
      messages: [{ role: "user", content: "Hello" }],
      shouldContinue: [() => true, (_reason, context) => context.iteration < 1],
    });

    expect(result.iterations).toBe(2);
  });

  it("applies onBeforeTurn overrides before streaming", async () => {
    const streamCalls: Array<{ system?: string }> = [];

    const agent: Agent = {
      config: { model: {} as Agent["config"]["model"] },
      stream(opts): AgentStreamResult {
        streamCalls.push({ system: opts.system });
        const fullStream: AsyncIterable<never> = {
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.resolve({ done: true, value: undefined }),
            };
          },
        };
        return {
          fullStream,
          finishReason: Promise.resolve("stop"),
          response: Promise.resolve({
            messages: [{ role: "assistant", content: "ok" }],
          } as Awaited<AgentStreamResult["response"]>),
        } as AgentStreamResult;
      },
    };

    await runAgentLoop({
      agent,
      messages: [{ role: "user", content: "Hello" }],
      onBeforeTurn: async () => ({ system: "prepared-system" }),
    });

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]?.system).toBe("prepared-system");
  });

  it("applies onPrepareStep before onBeforeTurn and forwards both", async () => {
    const streamCalls: Array<{
      experimentalContext?: { sessionId: string };
      system?: string;
    }> = [];

    const agent: Agent = {
      config: { model: {} as Agent["config"]["model"] },
      stream(opts): AgentStreamResult {
        streamCalls.push({
          experimentalContext: opts.experimentalContext as
            | { sessionId: string }
            | undefined,
          system: opts.system,
        });
        const fullStream: AsyncIterable<never> = {
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.resolve({ done: true, value: undefined }),
            };
          },
        };
        return {
          fullStream,
          finishReason: Promise.resolve("stop"),
          response: Promise.resolve({
            messages: [{ role: "assistant", content: "ok" }],
          } as Awaited<AgentStreamResult["response"]>),
          totalUsage: Promise.resolve(
            undefined
          ) as AgentStreamResult["totalUsage"],
          usage: Promise.resolve(undefined) as AgentStreamResult["usage"],
        };
      },
      close: async () => undefined,
    };

    await runAgentLoop({
      agent,
      messages: [{ role: "user", content: "Hello" }],
      onPrepareStep: async () => ({
        experimentalContext: { sessionId: "ses_prepared" },
        system: "prepared-system",
      }),
      onBeforeTurn: async () => ({ system: "final-system" }),
    });

    expect(streamCalls).toEqual([
      {
        experimentalContext: { sessionId: "ses_prepared" },
        system: "final-system",
      },
    ]);
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

  it("emits normalized tool lifecycle states including approval transitions", async () => {
    const lifecycles: Array<{
      approvalState?: string;
      state: string;
      toolName?: string;
    }> = [];

    const agent: Agent = {
      close: async () => undefined,
      config: {
        model: {} as Agent["config"]["model"],
      },
      stream(): AgentStreamResult {
        async function* fullStreamGenerator() {
          await Promise.resolve();
          yield {
            type: "tool-approval-request" as const,
            toolCallId: "call_approval",
            toolName: "bash",
          };
          yield {
            type: "tool-call" as const,
            toolCallId: "call_approval",
            toolName: "bash",
            input: { command: "pwd" },
          };
        }

        return {
          finishReason: Promise.resolve("stop"),
          fullStream: fullStreamGenerator(),
          response: Promise.resolve({
            messages: [{ role: "assistant", content: "done" }],
          } as Awaited<AgentStreamResult["response"]>),
          totalUsage: Promise.resolve(
            undefined
          ) as AgentStreamResult["totalUsage"],
          usage: Promise.resolve(undefined) as AgentStreamResult["usage"],
        };
      },
    };

    await runAgentLoop({
      agent,
      messages: [{ role: "user", content: "Hello" }],
      onToolLifecycle: (lifecycle) => {
        lifecycles.push({
          approvalState: lifecycle.approvalState,
          state: lifecycle.state,
          toolName: lifecycle.toolName,
        });
      },
    });

    expect(lifecycles).toEqual([
      {
        approvalState: "pending",
        state: "approval-requested",
        toolName: "bash",
      },
      {
        approvalState: "approved",
        state: "tool-call",
        toolName: "bash",
      },
    ]);
  });

  it("calls onInterrupt when aborted", async () => {
    const interrupts: Array<{ iteration: number; reason: string }> = [];
    const controller = new AbortController();

    const result = await runAgentLoop({
      agent: createMockAgent(["tool-calls", "tool-calls"]),
      messages: [{ role: "user", content: "Hello" }],
      abortSignal: controller.signal,
      onInterrupt: (interruption) => {
        interrupts.push(interruption);
      },
      onStepComplete: () => {
        controller.abort();
      },
    });

    expect(result.iterations).toBe(1);
    expect(interrupts).toEqual([{ iteration: 1, reason: "abort-signal" }]);
  });

  it("rethrows errors when onError does not request recovery", async () => {
    await expect(
      runAgentLoop({
        agent: createMockAgent(["tool-calls"], { throwOnIteration: 0 }),
        messages: [{ role: "user", content: "Hello" }],
        onError: () => undefined,
      })
    ).rejects.toThrow("boom-0");
  });

  it("continues with recovery messages when onError requests it", async () => {
    const result = await runAgentLoop({
      agent: createMockAgent(["tool-calls", "stop"], { throwOnIteration: 0 }),
      messages: [{ role: "user", content: "Hello" }],
      onError: () => ({
        shouldContinue: true,
        recovery: [{ role: "assistant", content: "Recovered" }],
      }),
    });

    expect(result.iterations).toBe(2);
    expect(result.finishReason).toBe("stop");
    expect(result.messages).toContainEqual({
      role: "assistant",
      content: "Recovered",
    });
  });

  it("rethrows when onError returns a response without shouldContinue", async () => {
    await expect(
      runAgentLoop({
        agent: createMockAgent(["tool-calls"], { throwOnIteration: 0 }),
        messages: [{ role: "user", content: "Hello" }],
        onError: () => ({ recovery: [] }),
      })
    ).rejects.toThrow("boom-0");
  });
});
