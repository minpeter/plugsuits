import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "./agent";
import type { AgentConfig } from "./types";

const { streamTextMock } = vi.hoisted(() => {
  const mock = vi.fn(() => {
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

  return { streamTextMock: mock };
});

vi.mock("ai", () => {
  return {
    stepCountIs: vi.fn(() => undefined),
    streamText: streamTextMock,
  };
});

function createMockModel(): AgentConfig["model"] {
  return {} as AgentConfig["model"];
}

describe("createAgent", () => {
  beforeEach(() => {
    streamTextMock.mockClear();
  });

  it("returns an agent with config and stream method", () => {
    const model = createMockModel();
    const agent = createAgent({ model });

    expect(agent).toHaveProperty("config");
    expect(agent).toHaveProperty("stream");
    expect(typeof agent.stream).toBe("function");
  });

  it("preserves provided config values", () => {
    const model = createMockModel();
    const config: AgentConfig = {
      model,
      instructions: "You are a harness test agent.",
      maxStepsPerTurn: 5,
    };

    const agent = createAgent(config);

    expect(agent.config.model).toBe(model);
    expect(agent.config.instructions).toBe("You are a harness test agent.");
    expect(agent.config.maxStepsPerTurn).toBe(5);
  });

  it("keeps maxStepsPerTurn undefined when omitted", () => {
    const agent = createAgent({ model: createMockModel() });

    expect(agent.config.maxStepsPerTurn).toBeUndefined();
  });

  it("passes temperature and seed through to streamText", () => {
    const agent = createAgent({ model: createMockModel() });

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
      const agent = createAgent({ model: createMockModel() });
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

      const streamResult: Record<string, unknown> = {
        finishReason: Promise.resolve("stop"),
        fullStream: emptyStream,
        response: Promise.resolve({ messages: [] }),
        totalUsage: Promise.resolve(undefined),
        usage: Promise.resolve(undefined),
      };
      let rejectTarget: (error: unknown) => void = () => undefined;
      streamResult[targetField] = new Promise<never>((_, reject) => {
        rejectTarget = reject;
      });

      streamTextMock.mockImplementationOnce(() => streamResult);

      const rejections: unknown[] = [];
      const handler = (reason: unknown) => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", handler);

      try {
        const agent = createAgent({ model: createMockModel() });
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
