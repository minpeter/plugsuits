import type { AgentStreamResult, ModelMessage } from "@ai-sdk-tool/harness";
import { CheckpointHistory } from "@ai-sdk-tool/harness";
import { describe, expect, it, vi } from "vitest";
import { runHeadless } from "./runner";
import type { TrajectoryEvent } from "./types";

function createMockStream(
  responseMessages: ModelMessage[],
  finishReason: "stop" | "tool-calls" = "stop",
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }
): AgentStreamResult {
  return {
    finishReason: Promise.resolve(finishReason),
    fullStream: (async function* () {
      await Promise.resolve();
      yield { type: "text-delta", text: "ok" };
      yield { type: "finish-step", finishReason };
    })() as unknown as AgentStreamResult["fullStream"],
    response: Promise.resolve({
      id: "mock-response",
      modelId: "mock-model",
      timestamp: new Date(),
      messages: responseMessages,
    } as unknown as Awaited<AgentStreamResult["response"]>),
    totalUsage: Promise.resolve(
      usage
    ) as unknown as AgentStreamResult["totalUsage"],
    usage: Promise.resolve(usage) as unknown as AgentStreamResult["usage"],
  };
}

function createToolCallStream(
  responseMessages: ModelMessage[],
  finishReason: "stop" | "tool-calls" = "stop"
): AgentStreamResult {
  return {
    finishReason: Promise.resolve(finishReason),
    fullStream: (async function* () {
      await Promise.resolve();
      yield { type: "tool-input-start", toolCallId: "call_1" };
      yield {
        type: "tool-input-delta",
        toolCallId: "call_1",
        inputTextDelta: '{"path":"src/index.ts"}',
      };
      yield {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "read_file",
        input: { path: "src/index.ts" },
      };
      yield {
        type: "tool-result",
        toolCallId: "call_1",
        output: { output: "file contents" },
      };
      yield { type: "text-delta", text: "done" };
      yield { type: "finish-step", finishReason };
    })() as unknown as AgentStreamResult["fullStream"],
    response: Promise.resolve({
      id: "mock-response",
      modelId: "mock-model",
      timestamp: new Date(),
      messages: responseMessages,
    } as unknown as Awaited<AgentStreamResult["response"]>),
    totalUsage: Promise.resolve(
      undefined
    ) as unknown as AgentStreamResult["totalUsage"],
    usage: Promise.resolve(undefined) as unknown as AgentStreamResult["usage"],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe("runHeadless", () => {
  it("adds and emits the initial user message via headless bootstrap", async () => {
    const events: TrajectoryEvent[] = [];
    const history = new CheckpointHistory();

    await runHeadless({
      agent: {
        stream: () =>
          createMockStream([{ role: "assistant", content: "hello" }]),
      },
      emitEvent: (event) => {
        events.push(event);
      },
      initialUserMessage: {
        content: "hello",
        eventContent: "안녕",
        originalContent: "안녕",
      },
      messageHistory: history,
      modelId: "mock-model",
      sessionId: "session-1",
    });

    expect(events[0]).toMatchObject({
      type: "step",
      source: "user",
      message: "안녕",
    });
    expect(history.getAll()[0]?.message).toEqual({
      role: "user",
      content: "hello",
    });
    expect(history.getAll()[0]?.originalContent).toBe("안녕");
  });

  it("does not emit a synthetic user event when no initial user message is given", async () => {
    const events: TrajectoryEvent[] = [];

    await runHeadless({
      agent: {
        stream: () =>
          createMockStream([{ role: "assistant", content: "hello" }]),
      },
      emitEvent: (event) => {
        events.push(event);
      },
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      sessionId: "session-2",
    });

    expect(
      events.some(
        (event) =>
          event.type === "step" && "source" in event && event.source === "user"
      )
    ).toBe(false);
  });

  it("compacts before a normal follow-up once the soft compaction threshold is exceeded", async () => {
    const summarizeDeferred = createDeferred<string>();
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        keepRecentTokens: 260,
        maxTokens: 600,
        reserveTokens: 200,
        summarizeFn: async () => await summarizeDeferred.promise,
      },
    });
    history.setContextLimit(600);

    let streamCallCount = 0;
    let secondCallMessages: ModelMessage[] = [];
    const runPromise = runHeadless({
      agent: {
        stream: ({ messages }) => {
          streamCallCount += 1;
          if (streamCallCount === 2) {
            secondCallMessages = messages;
          }

          return createMockStream(
            [
              {
                role: "assistant",
                content: streamCallCount === 1 ? "a".repeat(1000) : "done",
              },
            ],
            "stop",
            streamCallCount === 1
              ? {
                  inputTokens: 900,
                  outputTokens: 0,
                  totalTokens: 900,
                }
              : undefined
          );
        },
      },
      initialUserMessage: {
        content: "u".repeat(300),
      },
      messageHistory: history,
      modelId: "mock-model",
      onTodoReminder: async () => {
        await Promise.resolve();
        if (streamCallCount === 1) {
          return { hasReminder: true, message: "ok" };
        }
        return { hasReminder: false, message: null };
      },
      sessionId: "session-small-follow-up",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(streamCallCount).toBe(1);

    summarizeDeferred.resolve("Prepared summary");
    await runPromise;

    expect(streamCallCount).toBe(2);
    expect(secondCallMessages[0]?.role).toBe("user");
  });

  it("uses a usage probe to tighten the next stream budget", async () => {
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        keepRecentTokens: 100,
        maxTokens: 900,
        reserveTokens: 100,
        summarizeFn: async () => "summary",
      },
    });
    history.setContextLimit(1000);

    let probeCalls = 0;
    let observedMaxOutputTokens: number | undefined;

    await runHeadless({
      agent: {
        stream: ({ maxOutputTokens }) => {
          observedMaxOutputTokens = maxOutputTokens;
          return createMockStream(
            [{ role: "assistant", content: "done" }],
            "stop",
            {
              inputTokens: 420,
              outputTokens: 10,
              totalTokens: 430,
            }
          );
        },
      },
      initialUserMessage: {
        content: "measure the real prompt usage before streaming",
      },
      measureUsage: () => {
        probeCalls += 1;
        return Promise.resolve({
          inputTokens: 400,
          outputTokens: 1,
          totalTokens: 401,
        });
      },
      messageHistory: history,
      modelId: "mock-model",
      sessionId: "session-usage-probe",
    });

    expect(probeCalls).toBeGreaterThanOrEqual(1);
    expect(observedMaxOutputTokens).toBeGreaterThanOrEqual(512);
    expect(["actual", "estimated"]).toContain(history.getContextUsage().source);
  });

  it("blocks only when a follow-up hits the hard context limit", async () => {
    const summarizeDeferred = createDeferred<string>();
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        keepRecentTokens: 260,
        maxTokens: 600,
        reserveTokens: 200,
        summarizeFn: async () => await summarizeDeferred.promise,
      },
    });
    history.setContextLimit(600);

    let streamCallCount = 0;
    let secondCallMessages: ModelMessage[] = [];

    const runPromise = runHeadless({
      agent: {
        stream: ({ messages }) => {
          streamCallCount += 1;
          if (streamCallCount === 2) {
            secondCallMessages = messages;
          }

          return createMockStream([
            {
              role: "assistant",
              content: streamCallCount === 1 ? "a".repeat(1000) : "done",
            },
          ]);
        },
      },
      initialUserMessage: {
        content: "u".repeat(300),
      },
      messageHistory: history,
      modelId: "mock-model",
      onTodoReminder: async () => {
        await Promise.resolve();
        if (streamCallCount === 1) {
          return { hasReminder: true, message: "x".repeat(500) };
        }
        return { hasReminder: false, message: null };
      },
      sessionId: "session-large-follow-up",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(streamCallCount).toBe(1);

    summarizeDeferred.resolve("Prepared summary");
    await runPromise;

    expect(streamCallCount).toBe(2);
    expect(secondCallMessages[0]?.role).toBe("user");
  });

  it("can apply speculative compaction between internal tool-loop steps", async () => {
    const summarizeFn = vi.fn(async () => "Prepared summary");
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        keepRecentTokens: 260,
        maxTokens: 600,
        reserveTokens: 200,
        speculativeStartRatio: 0.5,
        summarizeFn,
      },
    });
    history.setContextLimit(600);

    const capturedMessages: ModelMessage[][] = [];
    let streamCallCount = 0;

    await runHeadless({
      agent: {
        stream: ({ messages }) => {
          capturedMessages.push(messages);
          streamCallCount += 1;

          return createMockStream(
            [
              {
                role: "assistant",
                content: streamCallCount === 1 ? "a".repeat(1000) : "done",
              },
            ],
            streamCallCount === 1 ? "tool-calls" : "stop"
          );
        },
      },
      initialUserMessage: {
        content: "u".repeat(300),
      },
      messageHistory: history,
      modelId: "mock-model",
      sessionId: "session-internal-step",
    });

    expect(streamCallCount).toBe(2);
    expect(summarizeFn).toHaveBeenCalled();
    expect(capturedMessages[1]?.[0]?.role).toBe("user");
  });

  it("emits ATIF-v1.6 step events for user messages and agent tool responses", async () => {
    const collectedEvents: TrajectoryEvent[] = [];

    await runHeadless({
      agent: {
        stream: () =>
          createToolCallStream([{ role: "assistant", content: "done" }]),
      },
      emitEvent: (event) => {
        collectedEvents.push(event);
      },
      initialUserMessage: {
        content: "inspect src/index.ts",
      },
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      sessionId: "session-jsonl-types",
    });

    expect(collectedEvents[0]).toMatchObject({
      type: "step",
      source: "user",
    });
    expect(collectedEvents[1]).toMatchObject({
      type: "step",
      source: "agent",
      tool_calls: expect.any(Array),
      observation: expect.any(Object),
    });
  });

  it("stops todo continuation after hitting the global max iteration budget", async () => {
    const events: TrajectoryEvent[] = [];
    let streamCallCount = 0;
    let todoReminderCalls = 0;

    await runHeadless({
      agent: {
        stream: () => {
          streamCallCount += 1;
          return createMockStream([{ role: "assistant", content: "done" }]);
        },
      },
      emitEvent: (event) => {
        events.push(event);
      },
      initialUserMessage: {
        content: "initial",
      },
      maxIterations: 1,
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      onTodoReminder: () => {
        todoReminderCalls += 1;
        return Promise.resolve({
          hasReminder: true,
          message: `follow-up-${todoReminderCalls}`,
        });
      },
      sessionId: "session-max-iterations-global",
    });

    expect(streamCallCount).toBe(1);
    expect(todoReminderCalls).toBe(1);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  });

  it("retries on context overflow error", async () => {
    const events: TrajectoryEvent[] = [];
    const history = new CheckpointHistory();
    let streamCallCount = 0;
    const overflowError = new Error("Context window exceeded");
    (overflowError as any).code = "context_length_exceeded";

    const agent = {
      stream: () => {
        streamCallCount += 1;
        if (streamCallCount === 1) {
          return Promise.reject(overflowError);
        }
        return createMockStream([{ role: "assistant", content: "success" }]);
      },
    };

    await runHeadless({
      agent,
      emitEvent: (event) => {
        events.push(event);
      },
      initialUserMessage: {
        content: "test overflow retry",
      },
      messageHistory: history,
      modelId: "mock-model",
      sessionId: "session-overflow-retry",
    });

    expect(streamCallCount).toBe(2);
    const agentEvents = events.filter(
      (e) => e.type === "step" && "source" in e && e.source === "agent"
    );
    expect(agentEvents).toHaveLength(1);
    expect(agentEvents[0]).toMatchObject({ message: "ok" });
  });

  it("retries once on no output generated error", async () => {
    const events: TrajectoryEvent[] = [];
    const history = new CheckpointHistory();
    let streamCallCount = 0;
    const noOutputError = new Error(
      "No output generated. Check the stream for errors."
    );

    const agent = {
      stream: () => {
        streamCallCount += 1;
        if (streamCallCount === 1) {
          return Promise.reject(noOutputError);
        }
        return createMockStream([{ role: "assistant", content: "success" }]);
      },
    };

    await runHeadless({
      agent,
      emitEvent: (event) => {
        events.push(event);
      },
      initialUserMessage: {
        content: "test empty-output retry",
      },
      messageHistory: history,
      modelId: "mock-model",
      sessionId: "session-no-output-retry",
    });

    expect(streamCallCount).toBe(2);
    const agentEvents = events.filter(
      (e) => e.type === "step" && "source" in e && e.source === "agent"
    );
    expect(agentEvents).toHaveLength(1);
    expect(agentEvents[0]).toMatchObject({ message: "ok" });
  });

  it("retries multiple times on no output generated error before succeeding", async () => {
    const events: TrajectoryEvent[] = [];
    const history = new CheckpointHistory();
    let streamCallCount = 0;
    const noOutputError = new Error(
      "No output generated. Check the stream for errors."
    );

    const agent = {
      stream: () => {
        streamCallCount += 1;
        if (streamCallCount < 4) {
          return Promise.reject(noOutputError);
        }
        return createMockStream([{ role: "assistant", content: "success" }]);
      },
    };

    await runHeadless({
      agent,
      emitEvent: (event) => {
        events.push(event);
      },
      initialUserMessage: {
        content: "test repeated no-output retry",
      },
      messageHistory: history,
      modelId: "mock-model",
      sessionId: "session-no-output-retry-multi",
    });

    expect(streamCallCount).toBe(4);
    const agentEvents = events.filter(
      (e) => e.type === "step" && "source" in e && e.source === "agent"
    );
    expect(agentEvents).toHaveLength(1);
  });
});
