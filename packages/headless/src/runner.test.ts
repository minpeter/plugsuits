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
      type: "metadata",
      session_id: "session-1",
      agent: {
        name: "plugsuits",
        version: "1.0.0",
        model_name: "mock-model",
      },
    });
    expect(events[1]).toMatchObject({
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

  it("emits a single turn-start event per logical turn in the normal path", async () => {
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
      initialUserMessage: { content: "hi" },
      messageHistory: history,
      modelId: "mock-model",
      sessionId: "session-turn-start-order",
    });

    const turnStartEvents = events.filter((e) => e.type === "turn-start");
    expect(turnStartEvents).toHaveLength(1);
    expect(turnStartEvents[0]).toMatchObject({
      type: "turn-start",
      phase: "new-turn",
    });

    const userIndex = events.findIndex(
      (e) => e.type === "step" && "source" in e && e.source === "user"
    );
    const turnStartIndex = events.findIndex((e) => e.type === "turn-start");
    const agentIndex = events.findIndex(
      (e) => e.type === "step" && "source" in e && e.source === "agent"
    );
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(turnStartIndex).toBeGreaterThan(userIndex);
    expect(agentIndex).toBeGreaterThan(turnStartIndex);
  });

  it("continues streaming when onStreamStart throws (observer errors are isolated)", async () => {
    const events: TrajectoryEvent[] = [];
    const history = new CheckpointHistory();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      await runHeadless({
        agent: {
          stream: () =>
            createMockStream([{ role: "assistant", content: "done" }]),
        },
        emitEvent: (event) => {
          events.push(event);
        },
        initialUserMessage: { content: "hi" },
        messageHistory: history,
        modelId: "mock-model",
        onStreamStart: () => {
          throw new Error("observer bug: should not break the stream");
        },
        sessionId: "session-observer-throws",
      });

      expect(events.some((e) => e.type === "turn-start")).toBe(true);
      const agentSteps = events.filter(
        (e) => e.type === "step" && "source" in e && e.source === "agent"
      );
      expect(agentSteps).toHaveLength(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("onStreamStart"),
        expect.any(Error)
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("does not emit turn-start when agent.stream() rejects before dispatch", async () => {
    const events: TrajectoryEvent[] = [];
    const history = new CheckpointHistory();
    const streamError = new Error("Provider refused the request");

    await runHeadless({
      agent: {
        stream: () => Promise.reject(streamError),
      },
      emitEvent: (event) => {
        events.push(event);
      },
      initialUserMessage: { content: "hi" },
      messageHistory: history,
      modelId: "mock-model",
      sessionId: "session-stream-failure",
    }).catch(() => undefined);

    expect(events.some((e) => e.type === "turn-start")).toBe(false);
  });

  it("emits turn-start after agent.stream() succeeds (before first chunk)", async () => {
    const events: TrajectoryEvent[] = [];
    const history = new CheckpointHistory();
    const eventOrder: string[] = [];
    let streamCallCount = 0;

    await runHeadless({
      agent: {
        stream: () => {
          streamCallCount += 1;
          eventOrder.push("agent.stream() called");
          return createMockStream([{ role: "assistant", content: "response" }]);
        },
      },
      emitEvent: (event) => {
        if (event.type === "turn-start") {
          eventOrder.push("turn-start emitted");
        }
        events.push(event);
      },
      initialUserMessage: { content: "hi" },
      messageHistory: history,
      modelId: "mock-model",
      sessionId: "session-turn-start-order-vs-stream",
    });

    expect(streamCallCount).toBe(1);
    const streamIdx = eventOrder.indexOf("agent.stream() called");
    const turnStartIdx = eventOrder.indexOf("turn-start emitted");
    expect(streamIdx).toBeGreaterThanOrEqual(0);
    expect(turnStartIdx).toBeGreaterThan(streamIdx);
  });

  it("emits an intermediate-step turn-start on tool-continuation turns", async () => {
    const events: TrajectoryEvent[] = [];
    const history = new CheckpointHistory();
    let streamCallCount = 0;

    await runHeadless({
      agent: {
        stream: () => {
          streamCallCount += 1;
          if (streamCallCount === 1) {
            return createToolCallStream(
              [{ role: "assistant", content: "call_1" }],
              "tool-calls"
            );
          }
          return createMockStream([{ role: "assistant", content: "done" }]);
        },
      },
      emitEvent: (event) => {
        events.push(event);
      },
      initialUserMessage: { content: "do it" },
      messageHistory: history,
      modelId: "mock-model",
      sessionId: "session-intermediate-turn-start",
    });

    expect(streamCallCount).toBe(2);
    const turnStartPhases = events
      .filter((e) => e.type === "turn-start")
      .map((e) => (e as { phase: string }).phase);
    expect(turnStartPhases).toEqual(["new-turn", "intermediate-step"]);
  });

  it("excludes turn-start events from the ATIF trajectory JSON", async () => {
    const events: TrajectoryEvent[] = [];
    const history = new CheckpointHistory();
    const atifOutputPath = `/tmp/plugsuits-turn-start-${Date.now()}.json`;

    await runHeadless({
      agent: {
        stream: () =>
          createMockStream([{ role: "assistant", content: "hello" }]),
      },
      atifOutputPath,
      emitEvent: (event) => {
        events.push(event);
      },
      initialUserMessage: { content: "hi" },
      messageHistory: history,
      modelId: "mock-model",
      sessionId: "session-trajectory-persistence-check",
    });

    expect(events.some((e) => e.type === "turn-start")).toBe(true);

    const { readFileSync, unlinkSync } = await import("node:fs");
    const persisted = JSON.parse(readFileSync(atifOutputPath, "utf-8")) as {
      schema_version: string;
      steps: Array<{ step_id: number; source: string }>;
      extra?: Record<string, unknown>;
    };
    unlinkSync(atifOutputPath);

    expect(persisted.schema_version).toBe("ATIF-v1.4");
    const stepSources = persisted.steps.map((s) => s.source);
    expect(stepSources).not.toContain("turn-start");
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain("turn-start");
  });

  it("does not write an invalid zero-step trajectory when the stream fails before any step", async () => {
    const history = new CheckpointHistory();
    const atifOutputPath = `/tmp/plugsuits-zero-step-${Date.now()}.json`;
    const { existsSync } = await import("node:fs");

    await runHeadless({
      agent: {
        stream: () =>
          Promise.reject(new Error("provider unreachable")) as never,
      },
      atifOutputPath,
      emitEvent: () => undefined,
      // Deliberately omit initialUserMessage so no user step precedes the abort.
      messageHistory: history,
      modelId: "mock-model",
      sessionId: "session-zero-step-guard",
    }).catch(() => undefined);

    expect(existsSync(atifOutputPath)).toBe(false);
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

  it("emits ATIF-v1.4 step events for user messages and agent tool responses", async () => {
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

    const stepEvents = collectedEvents.filter(
      (event): event is Extract<TrajectoryEvent, { type: "step" }> =>
        event.type === "step"
    );

    expect(stepEvents[0]).toMatchObject({
      type: "step",
      source: "user",
    });
    expect(stepEvents[1]).toMatchObject({
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
    const turnStartEvents = events.filter((e) => e.type === "turn-start");
    expect(turnStartEvents).toHaveLength(1);
    expect(turnStartEvents[0]).toMatchObject({ phase: "new-turn" });
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
    const turnStartEvents = events.filter((e) => e.type === "turn-start");
    expect(turnStartEvents).toHaveLength(1);
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
    const turnStartEvents = events.filter((e) => e.type === "turn-start");
    expect(turnStartEvents).toHaveLength(1);
  });

  it("emits an interrupt event and stops when the caller aborts", async () => {
    const events: TrajectoryEvent[] = [];
    const controller = new AbortController();

    await runHeadless({
      agent: {
        stream: async () => {
          await Promise.resolve();
          controller.abort();
          throw new Error("Aborted by caller");
        },
      },
      abortSignal: controller.signal,
      emitEvent: (event) => {
        events.push(event);
      },
      initialUserMessage: {
        content: "abort me",
      },
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      sessionId: "session-abort",
    });

    expect(events.filter((event) => event.type === "interrupt")).toContainEqual(
      expect.objectContaining({
        reason: "caller-abort",
      })
    );
  });

  it("preserves caller aborts when onBeforeTurn also supplies an abort signal", async () => {
    const events: TrajectoryEvent[] = [];
    const controller = new AbortController();
    const overrideController = new AbortController();
    let receivedAbortSignal: AbortSignal | undefined;

    await runHeadless({
      agent: {
        stream: (options) => {
          receivedAbortSignal = options.abortSignal;
          controller.abort();
          expect(receivedAbortSignal?.aborted).toBe(true);

          throw new Error("Aborted by caller");
        },
      },
      abortSignal: controller.signal,
      emitEvent: (event) => {
        events.push(event);
      },
      initialUserMessage: {
        content: "abort me too",
      },
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      onBeforeTurn: () => ({
        abortSignal: overrideController.signal,
      }),
      sessionId: "session-abort-merged-signal",
    });

    expect(events.filter((event) => event.type === "interrupt")).toContainEqual(
      expect.objectContaining({
        reason: "caller-abort",
      })
    );
  });

  it("uses maxTodoReminders instead of the legacy hardcoded reminder cap", async () => {
    const events: TrajectoryEvent[] = [];

    await runHeadless({
      agent: {
        stream: () =>
          createMockStream([{ role: "assistant", content: "done" }]),
      },
      emitEvent: (event) => {
        events.push(event);
      },
      initialUserMessage: {
        content: "initial",
      },
      maxTodoReminders: 2,
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      onTodoReminder: () =>
        Promise.resolve({
          hasReminder: true,
          message: "follow-up",
        }),
      sessionId: "session-max-todo-reminders",
    });

    expect(events.filter((event) => event.type === "error")).toContainEqual(
      expect.objectContaining({
        code: "MAX_ITERATIONS",
        error: "Todo continuation safety cap reached (2 reminders).",
      })
    );
  });

  it("passes finish reason and snapshot to onTurnComplete", async () => {
    const onTurnComplete = vi.fn();

    await runHeadless({
      agent: {
        stream: () =>
          createMockStream([{ role: "assistant", content: "done" }]),
      },
      initialUserMessage: {
        content: "initial",
      },
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      onTurnComplete,
      sessionId: "session-turn-complete-finish-reason",
    });

    expect(onTurnComplete).toHaveBeenCalledWith(
      expect.any(Array),
      undefined,
      expect.objectContaining({
        messages: expect.any(Array),
      }),
      "stop"
    );
  });

  it("passes totalTokens to onTurnComplete when usage exists", async () => {
    const onTurnComplete = vi.fn();

    await runHeadless({
      agent: {
        stream: () =>
          createMockStream([{ role: "assistant", content: "done" }], "stop", {
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 18,
          }),
      },
      initialUserMessage: {
        content: "initial",
      },
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      onTurnComplete,
      sessionId: "session-turn-complete-total-tokens",
    });

    expect(onTurnComplete).toHaveBeenCalledWith(
      expect.any(Array),
      {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      },
      expect.objectContaining({
        messages: expect.any(Array),
      }),
      "stop"
    );
  });

  it("emits approval lifecycle events in headless mode", async () => {
    const events: TrajectoryEvent[] = [];

    await runHeadless({
      agent: {
        stream: () => ({
          finishReason: Promise.resolve("stop"),
          fullStream: (async function* () {
            await Promise.resolve();
            yield {
              type: "tool-approval-request",
              toolCallId: "call_approval",
              toolName: "bash",
              reason: "Needs user approval",
              providerExecuted: false,
            };
            yield { type: "text-delta", text: "waiting" };
            yield { type: "finish-step", finishReason: "stop" };
          })() as unknown as AgentStreamResult["fullStream"],
          response: Promise.resolve({
            id: "mock-response",
            modelId: "mock-model",
            timestamp: new Date(),
            messages: [{ role: "assistant", content: "waiting" }],
          } as Awaited<AgentStreamResult["response"]>),
          totalUsage: Promise.resolve(
            undefined
          ) as unknown as AgentStreamResult["totalUsage"],
          usage: Promise.resolve(
            undefined
          ) as unknown as AgentStreamResult["usage"],
        }),
      },
      emitEvent: (event) => {
        events.push(event);
      },
      initialUserMessage: {
        content: "initial",
      },
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      sessionId: "session-approval-event",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "approval",
        state: "pending",
        toolCallId: "call_approval",
        toolName: "bash",
        reason: "Needs user approval",
        providerExecuted: false,
      })
    );
  });

  it("uses custom shouldContinue when provided", async () => {
    let streamCallCount = 0;

    await runHeadless({
      agent: {
        stream: () => {
          streamCallCount += 1;
          return createMockStream(
            [{ role: "assistant", content: "done" }],
            "tool-calls"
          );
        },
      },
      initialUserMessage: {
        content: "initial",
      },
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      sessionId: "session-custom-should-continue",
      shouldContinue: () => false,
    });

    expect(streamCallCount).toBe(1);
  });

  it("runs onBeforeTurn before each stream call", async () => {
    const onBeforeTurn = vi.fn();
    let streamCallCount = 0;

    await runHeadless({
      agent: {
        stream: () => {
          streamCallCount += 1;
          return createMockStream(
            [
              {
                role: "assistant",
                content: streamCallCount === 1 ? "step" : "done",
              },
            ],
            streamCallCount === 1 ? "tool-calls" : "stop"
          );
        },
      },
      initialUserMessage: {
        content: "initial",
      },
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      onBeforeTurn,
      sessionId: "session-on-before-turn",
    });

    expect(onBeforeTurn).toHaveBeenNthCalledWith(1, "new-turn");
    expect(onBeforeTurn).toHaveBeenNthCalledWith(2, "intermediate-step");
  });

  it("passes onBeforeTurn stream overrides into agent.stream", async () => {
    const stream = vi.fn(() =>
      createMockStream([{ role: "assistant", content: "done" }])
    );

    await runHeadless({
      agent: { stream },
      initialUserMessage: {
        content: "initial",
      },
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      onBeforeTurn: () => ({
        providerOptions: { openai: { parallelToolCalls: false } },
        seed: 42,
        system: "prepared-system",
        temperature: 0,
      }),
      sessionId: "session-on-before-turn-overrides",
    });

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { openai: { parallelToolCalls: false } },
        seed: 42,
        system: "prepared-system",
        temperature: 0,
      })
    );
  });

  it("lets onBeforeTurn override messages and maxOutputTokens", async () => {
    const stream = vi.fn(() =>
      createMockStream([{ role: "assistant", content: "done" }])
    );

    await runHeadless({
      agent: { stream },
      initialUserMessage: {
        content: "initial",
      },
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      onBeforeTurn: () => ({
        maxOutputTokens: 64,
        messages: [{ role: "system", content: "override" }],
      }),
      sessionId: "session-on-before-turn-full-overrides",
    });

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 64,
        messages: [{ role: "system", content: "override" }],
      })
    );
  });

  it("merges caller and onBeforeTurn abort signals before streaming", async () => {
    const callerAbortController = new AbortController();
    const overrideAbortController = new AbortController();
    let capturedAbortSignal: AbortSignal | undefined;

    await runHeadless({
      agent: {
        stream: ({ abortSignal }) => {
          capturedAbortSignal = abortSignal;
          return createMockStream([{ role: "assistant", content: "done" }]);
        },
      },
      abortSignal: callerAbortController.signal,
      initialUserMessage: {
        content: "initial",
      },
      messageHistory: new CheckpointHistory(),
      modelId: "mock-model",
      onBeforeTurn: () => ({
        abortSignal: overrideAbortController.signal,
      }),
      sessionId: "session-on-before-turn-abort-signal-merge",
    });

    expect(capturedAbortSignal).toBeDefined();
    expect(capturedAbortSignal).not.toBe(callerAbortController.signal);
    expect(capturedAbortSignal).not.toBe(overrideAbortController.signal);

    callerAbortController.abort();
    expect(capturedAbortSignal?.aborted).toBe(true);
  });
});
