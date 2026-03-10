import { describe, expect, it, mock } from "bun:test";
import type { AgentStreamResult, ModelMessage } from "@ai-sdk-tool/harness";
import { MessageHistory } from "@ai-sdk-tool/harness";
import { runHeadless } from "./runner";

function createMockStream(
  responseMessages: ModelMessage[],
  finishReason: "stop" | "tool-calls" = "stop"
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
      undefined
    ) as unknown as AgentStreamResult["totalUsage"],
    usage: Promise.resolve(undefined) as unknown as AgentStreamResult["usage"],
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
    const events: Array<{ content?: string; type: string }> = [];
    const history = new MessageHistory();

    await runHeadless({
      agent: {
        stream: () =>
          createMockStream([{ role: "assistant", content: "hello" }]),
      },
      emitEvent: (event) => {
        events.push({
          type: event.type,
          content: "content" in event ? event.content : undefined,
        });
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

    expect(events[0]).toEqual({ type: "user", content: "안녕" });
    expect(history.getAll()[0]?.modelMessage).toEqual({
      role: "user",
      content: "hello",
    });
    expect(history.getAll()[0]?.originalContent).toBe("안녕");
  });

  it("does not emit a synthetic user event when no initial user message is given", async () => {
    const events: Array<{ content?: string; type: string }> = [];

    await runHeadless({
      agent: {
        stream: () =>
          createMockStream([{ role: "assistant", content: "hello" }]),
      },
      emitEvent: (event) => {
        events.push({
          type: event.type,
          content: "content" in event ? event.content : undefined,
        });
      },
      messageHistory: new MessageHistory(),
      modelId: "mock-model",
      sessionId: "session-2",
    });

    expect(events.some((event) => event.type === "user")).toBe(false);
  });

  it("does not block a normal follow-up while speculative compaction is still running below the hard limit", async () => {
    const summarizeDeferred = createDeferred<string>();
    const history = new MessageHistory({
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
    const secondCallSeen = createDeferred<void>();

    const runPromise = runHeadless({
      agent: {
        stream: ({ messages }) => {
          streamCallCount += 1;
          if (streamCallCount === 2) {
            secondCallMessages = messages;
            secondCallSeen.resolve();
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
        if (streamCallCount === 1) {
          return { hasReminder: true, message: "ok" };
        }
        return { hasReminder: false, message: null };
      },
      sessionId: "session-small-follow-up",
    });

    await Promise.race([
      secondCallSeen.promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("second stream call did not start")),
          500
        )
      ),
    ]);

    expect(secondCallMessages[0]?.role).not.toBe("system");

    summarizeDeferred.resolve("Prepared summary");
    await runPromise;
  });

  it("blocks only when a follow-up hits the hard context limit", async () => {
    const summarizeDeferred = createDeferred<string>();
    const history = new MessageHistory({
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
    expect(secondCallMessages[0]?.role).toBe("system");
  });

  it("can apply speculative compaction between internal tool-loop steps", async () => {
    const summarizeFn = mock(async () => "Prepared summary");
    const history = new MessageHistory({
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
    expect(capturedMessages[1]?.[0]?.role).toBe("system");
  });

  it("re-fires stale speculative compaction once at the hard limit", async () => {
    const firstPreparedDeferred = createDeferred<{ id: "stale" }>();
    const secondPreparedDeferred = createDeferred<{ id: "fresh" }>();
    const storedMessages: ModelMessage[] = [];
    let compactionApplied = false;
    let hardLimitActive = false;
    let prepareCallCount = 0;

    let streamCallCount = 0;
    let secondCallMessages: ModelMessage[] = [];
    const secondCallSeen = createDeferred<void>();

    const prepareSpeculativeCompaction = mock(async () => {
      prepareCallCount += 1;

      if (prepareCallCount === 1) {
        return (await firstPreparedDeferred.promise) as never;
      }

      if (prepareCallCount === 2) {
        return (await secondPreparedDeferred.promise) as never;
      }

      throw new Error("prepareSpeculativeCompaction called too many times");
    });

    const history = {
      addModelMessages(messages: ModelMessage[]) {
        storedMessages.push(...messages);
        return [] as unknown[];
      },
      addUserMessage(content: string) {
        storedMessages.push({ role: "user", content });
        return {} as never;
      },
      applyPreparedCompaction(prepared: { id: "fresh" | "stale" }) {
        if (prepared.id === "stale") {
          return { applied: false, reason: "stale" as const };
        }

        compactionApplied = true;
        return { applied: true, reason: "applied" as const };
      },
      getMessagesForLLM() {
        return compactionApplied
          ? ([
              { role: "system", content: "summary" },
              ...storedMessages,
            ] as ModelMessage[])
          : [...storedMessages];
      },
      isAtHardContextLimit() {
        return hardLimitActive && !compactionApplied;
      },
      prepareSpeculativeCompaction,
      shouldStartSpeculativeCompactionForNextTurn() {
        return (
          streamCallCount >= 1 && !compactionApplied && prepareCallCount < 2
        );
      },
      updateActualUsage() {},
    } as unknown as MessageHistory;

    const runPromise = runHeadless({
      agent: {
        stream: ({ messages }) => {
          streamCallCount += 1;
          if (streamCallCount === 2) {
            secondCallMessages = messages;
            secondCallSeen.resolve();
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
        if (streamCallCount === 1) {
          hardLimitActive = true;
          return { hasReminder: true, message: "x".repeat(500) };
        }

        return { hasReminder: false, message: null };
      },
      sessionId: "session-stale-refire",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(streamCallCount).toBe(1);
    expect(prepareSpeculativeCompaction).toHaveBeenCalledTimes(1);

    firstPreparedDeferred.resolve({ id: "stale" });

    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 20)),
      secondCallSeen.promise,
    ]);

    expect(streamCallCount).toBe(1);
    expect(prepareSpeculativeCompaction).toHaveBeenCalledTimes(2);

    secondPreparedDeferred.resolve({ id: "fresh" });

    await Promise.race([
      secondCallSeen.promise,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("second stream call did not start after refire")),
          500
        )
      ),
    ]);

    await runPromise;

    expect(streamCallCount).toBe(2);
    expect(prepareSpeculativeCompaction).toHaveBeenCalledTimes(2);
    expect(secondCallMessages[0]?.role).toBe("system");
  });

  it("keeps JSONL event types unchanged", async () => {
    const eventTypes: string[] = [];

    await runHeadless({
      agent: {
        stream: () =>
          createToolCallStream([{ role: "assistant", content: "done" }]),
      },
      emitEvent: (event) => {
        eventTypes.push(event.type);
      },
      initialUserMessage: {
        content: "inspect src/index.ts",
      },
      messageHistory: new MessageHistory(),
      modelId: "mock-model",
      sessionId: "session-jsonl-types",
    });

    expect(eventTypes).toEqual([
      "user",
      "tool_call",
      "tool_result",
      "assistant",
    ]);
    expect(new Set(eventTypes)).toEqual(
      new Set(["user", "tool_call", "tool_result", "assistant"])
    );
  });
});
