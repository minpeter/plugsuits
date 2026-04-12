import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "./agent";
import { AgentError, AgentErrorCode } from "./errors";
import { clearMCPCache } from "./mcp-init";
import type { AgentConfig } from "./types";

const streamTextMock = vi.fn(() => {
  const fullStream: AsyncIterable<{ finishReason: string; type: string }> = {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        next: () => {
          if (done) {
            return Promise.resolve({ done: true, value: undefined });
          }
          done = true;
          return Promise.resolve({
            done: false,
            value: { type: "finish-step", finishReason: "stop" },
          });
        },
      };
    },
  };
  return {
    finishReason: Promise.resolve("stop"),
    fullStream,
    response: Promise.resolve({ messages: [] }),
    totalUsage: Promise.resolve(undefined),
    usage: Promise.resolve(undefined),
  };
});

const resolveMCPOptionMock = vi.fn().mockResolvedValue({
  close: vi.fn().mockResolvedValue(undefined),
  tools: { mcp_tool: {} },
});

const stepCountIsMock = vi.fn(() => undefined);

vi.mock("ai", () => {
  return {
    stepCountIs: stepCountIsMock,
    streamText: streamTextMock,
  };
});

vi.mock("./mcp-init.js", () => ({
  clearMCPCache: vi.fn(),
  resolveMCPOption: resolveMCPOptionMock,
}));

function createMockModel(): AgentConfig["model"] {
  return {} as AgentConfig["model"];
}

function getLastStreamTextCall() {
  const calls = streamTextMock.mock.calls as unknown as Array<
    Array<{ stopWhen?: unknown }>
  >;
  if (calls.length === 0) {
    throw new Error("Expected streamText to be called");
  }
  const lastCall = calls.at(-1);
  return lastCall ? lastCall[0] : undefined;
}

function getStopWhen() {
  const lastCall = getLastStreamTextCall();
  if (!lastCall) {
    throw new Error("Expected streamText call arguments");
  }
  const stopWhen = lastCall.stopWhen;
  if (!stopWhen) {
    throw new Error("Expected stopWhen to be defined");
  }
  return stopWhen;
}

describe("createAgent", () => {
  beforeEach(() => {
    clearMCPCache();
    resolveMCPOptionMock.mockClear();
    streamTextMock.mockClear();
    stepCountIsMock.mockClear();
  });

  it("returns an agent with config, stream method, and close method", async () => {
    const model = createMockModel();
    const agent = await createAgent({ model });

    expect(agent).toHaveProperty("config");
    expect(agent).toHaveProperty("close");
    expect(agent).toHaveProperty("stream");
    expect(typeof agent.close).toBe("function");
    expect(typeof agent.stream).toBe("function");
  });

  it("preserves provided config values", async () => {
    const model = createMockModel();
    const config: AgentConfig = {
      model,
      instructions: "You are a harness test agent.",
      maxStepsPerTurn: 5,
    };

    const agent = await createAgent(config);

    expect(agent.config.model).toBe(model);
    expect(agent.config.instructions).toBe("You are a harness test agent.");
    expect(agent.config.maxStepsPerTurn).toBe(5);
  });

  it("keeps maxStepsPerTurn undefined when omitted", async () => {
    const agent = await createAgent({ model: createMockModel() });

    expect(agent.config.maxStepsPerTurn).toBeUndefined();
  });

  it("uses text-response stop condition when maxStepsPerTurn is omitted and guardrails are not set", async () => {
    const agent = await createAgent({ model: createMockModel() });

    agent.stream({ messages: [] });

    expect(stepCountIsMock).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stopWhen: expect.any(Array),
      })
    );

    const stopWhen = getStopWhen();
    expect(stopWhen).toHaveLength(1);
    expect(
      stopWhen[0]({
        steps: [
          { toolCalls: [{ input: { city: "Seoul" }, toolName: "weather" }] },
        ],
      })
    ).toBe(false);
    expect(
      stopWhen[0]({
        steps: [{ toolCalls: [] }],
      })
    ).toBe(true);
  });

  it("throws MAX_TOOL_CALLS when unlimited-mode guardrail is exceeded", async () => {
    const agent = await createAgent({
      guardrails: { maxToolCallsPerTurn: 2 },
      model: createMockModel(),
    });

    agent.stream({ messages: [] });

    const stopWhen = getStopWhen();

    expect(() =>
      stopWhen[0]({
        steps: [
          { toolCalls: [{ input: { q: 1 }, toolName: "search" }] },
          { toolCalls: [{ input: { q: 2 }, toolName: "search" }] },
        ],
      })
    ).toThrowError(
      expect.objectContaining({
        code: AgentErrorCode.MAX_TOOL_CALLS,
        message: "Exceeded maxToolCallsPerTurn (2)",
      })
    );
  });

  it("throws REPEATED_TOOL_CALL when same tool and args repeat in a row", async () => {
    const agent = await createAgent({
      guardrails: { repeatedToolCallThreshold: 3 },
      model: createMockModel(),
    });

    agent.stream({ messages: [] });

    const stopWhen = getStopWhen();

    expect(() =>
      stopWhen[0]({
        steps: [
          { toolCalls: [{ input: { query: "pizza" }, toolName: "search" }] },
          { toolCalls: [{ input: { query: "pizza" }, toolName: "search" }] },
          { toolCalls: [{ input: { query: "pizza" }, toolName: "search" }] },
        ],
      })
    ).toThrowError(AgentError);

    try {
      stopWhen[0]({
        steps: [
          { toolCalls: [{ input: { query: "pizza" }, toolName: "search" }] },
          { toolCalls: [{ input: { query: "pizza" }, toolName: "search" }] },
          { toolCalls: [{ input: { query: "pizza" }, toolName: "search" }] },
        ],
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: AgentErrorCode.REPEATED_TOOL_CALL,
        message: "Detected repeated tool call 3 times in a row: search",
      });
    }
  });

  it("completes normally when tool calls are followed by text response", async () => {
    const agent = await createAgent({
      guardrails: { maxToolCallsPerTurn: 5, repeatedToolCallThreshold: 3 },
      model: createMockModel(),
    });

    agent.stream({ messages: [] });

    const stopWhen = getStopWhen();

    expect(
      stopWhen[0]({
        steps: [
          { toolCalls: [{ input: { query: "pizza" }, toolName: "search" }] },
          { toolCalls: [] },
        ],
      })
    ).toBe(true);
  });

  it("does not apply guardrails when maxStepsPerTurn is explicitly set", async () => {
    const agent = await createAgent({
      guardrails: { maxToolCallsPerTurn: 1, repeatedToolCallThreshold: 1 },
      maxStepsPerTurn: 4,
      model: createMockModel(),
    });

    agent.stream({ messages: [] });

    expect(stepCountIsMock).toHaveBeenCalledWith(4);
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stopWhen: undefined,
      })
    );
  });

  it("passes temperature and seed through to streamText", async () => {
    const agent = await createAgent({ model: createMockModel() });

    agent.stream({
      messages: [],
      seed: 42,
      temperature: 0,
    });

    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        seed: 42,
        temperature: 0,
      })
    );
  });

  it("agent.close is a no-op when MCP is not configured", async () => {
    const agent = await createAgent({ model: createMockModel() });

    await expect(agent.close()).resolves.toBeUndefined();
  });

  it("calls resolveMCPOption when MCP is provided", async () => {
    const model = createMockModel();

    await createAgent({ model, mcp: true });

    expect(resolveMCPOptionMock).toHaveBeenCalledWith(true, {});
  });

  it("returns an agent with MCP-resolved tools and close handler", async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const mcpTools = { mcp_tool: {} };
    resolveMCPOptionMock.mockResolvedValueOnce({
      close: closeMock,
      tools: mcpTools,
    });

    const agent = await createAgent({ model: createMockModel(), mcp: true });

    expect(agent.config.tools).toBe(mcpTools);

    await agent.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("silences unhandled rejections when stream result promises are not awaited", async () => {
    const rejectionError = new Error("NoOutputGeneratedError");
    const emptyStream: AsyncIterable<{ finishReason: string; type: string }> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: true, value: undefined }),
        };
      },
    };

    interface Deferred {
      promise: Promise<never>;
      reject: (error: unknown) => void;
    }
    const createDeferred = (): Deferred => {
      let rejectFn: (error: unknown) => void = () => undefined;
      const promise = new Promise<never>((_, reject) => {
        rejectFn = reject;
      });
      return { promise, reject: rejectFn };
    };

    const finishReasonDeferred = createDeferred();
    const responseDeferred = createDeferred();
    const usageDeferred = createDeferred();
    const totalUsageDeferred = createDeferred();

    streamTextMock.mockImplementationOnce(() => ({
      finishReason: finishReasonDeferred.promise,
      fullStream: emptyStream,
      response: responseDeferred.promise,
      totalUsage: totalUsageDeferred.promise,
      usage: usageDeferred.promise,
    }));

    const rejections: unknown[] = [];
    const handler = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", handler);

    try {
      const agent = await createAgent({ model: createMockModel() });
      const result = agent.stream({ messages: [] });

      finishReasonDeferred.reject(rejectionError);
      responseDeferred.reject(rejectionError);
      usageDeferred.reject(rejectionError);
      totalUsageDeferred.reject(rejectionError);

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(rejections).toHaveLength(0);

      await expect(result.finishReason).rejects.toBe(rejectionError);
      await expect(result.response).rejects.toBe(rejectionError);
      await expect(result.usage).rejects.toBe(rejectionError);
      await expect(result.totalUsage).rejects.toBe(rejectionError);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  describe.each([
    "finishReason" as const,
    "response" as const,
    "usage" as const,
    "totalUsage" as const,
  ])("silences rejection on %s field in isolation", (targetField) => {
    it("captures zero unhandled rejections when that field alone rejects", async () => {
      const rejectionError = new Error(`rejection-from-${targetField}`);
      const emptyStream: AsyncIterable<{ finishReason: string; type: string }> =
        {
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.resolve({ done: true, value: undefined }),
            };
          },
        };

      const streamResult = {
        finishReason: Promise.resolve("stop"),
        fullStream: emptyStream,
        response: Promise.resolve({ messages: [] }),
        totalUsage: Promise.resolve(undefined),
        usage: Promise.resolve(undefined),
      } as ReturnType<typeof streamTextMock>;
      let rejectTarget: (error: unknown) => void = () => undefined;
      Object.defineProperty(streamResult, targetField, {
        configurable: true,
        enumerable: true,
        value: new Promise<never>((_, reject) => {
          rejectTarget = reject;
        }),
        writable: true,
      });

      streamTextMock.mockImplementationOnce(() => streamResult);

      const rejections: unknown[] = [];
      const handler = (reason: unknown) => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", handler);

      try {
        const agent = await createAgent({ model: createMockModel() });
        const result = agent.stream({ messages: [] });

        rejectTarget(rejectionError);

        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(rejections).toHaveLength(0);
        await expect(result[targetField] as Promise<unknown>).rejects.toBe(
          rejectionError
        );
      } finally {
        process.off("unhandledRejection", handler);
      }
    });
  });
});
