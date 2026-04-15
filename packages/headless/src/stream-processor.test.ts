import type { AgentStreamResult } from "@ai-sdk-tool/harness";
import { describe, expect, it } from "vitest";
import { extractToolOutput, processStream } from "./stream-processor";
import type { TrajectoryEvent } from "./types";

const createNeverSettlingPromise = <T>(): Promise<T> =>
  new Promise<T>((_resolve) => undefined);

describe("processStream", () => {
  it("stops continuation when the stream response times out", async () => {
    const events: TrajectoryEvent[] = [];

    const result = await processStream({
      emitEvent: (event) => {
        events.push(event);
      },
      modelId: "mock-model",
      onMessages: () => undefined,
      stepId: 1,
      streamTimeoutMs: 1,
      shouldContinue: (finishReason) => finishReason === "tool-calls",
      stream: {
        finishReason: Promise.resolve("stop"),
        fullStream: (async function* () {
          await Promise.resolve();
          yield* [];
        })() as unknown as AgentStreamResult["fullStream"],
        response: createNeverSettlingPromise(),
        totalUsage: Promise.resolve(
          undefined
        ) as unknown as AgentStreamResult["totalUsage"],
        usage: Promise.resolve(
          undefined
        ) as unknown as AgentStreamResult["usage"],
      },
    });

    expect(result.shouldContinue).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        error: "Error: Stream response timeout after 1ms",
      }),
    ]);
  }, 5000);

  it("emits approval events for tool approval requests", async () => {
    const events: TrajectoryEvent[] = [];

    await processStream({
      emitEvent: (event) => {
        events.push(event);
      },
      modelId: "mock-model",
      onMessages: () => undefined,
      stepId: 1,
      shouldContinue: () => false,
      stream: {
        finishReason: Promise.resolve("stop"),
        fullStream: (async function* () {
          await Promise.resolve();
          yield {
            type: "tool-approval-request",
            toolCallId: "call_approval",
            toolName: "bash",
            reason: "Deletes files",
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
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "approval",
        state: "pending",
        toolCallId: "call_approval",
        toolName: "bash",
        reason: "Deletes files",
        providerExecuted: false,
      })
    );
  });

  it("emits approval resolution events for approved and denied flows", async () => {
    const events: TrajectoryEvent[] = [];

    await processStream({
      emitEvent: (event) => {
        events.push(event);
      },
      modelId: "mock-model",
      onMessages: () => undefined,
      stepId: 1,
      shouldContinue: () => false,
      stream: {
        finishReason: Promise.resolve("stop"),
        fullStream: (async function* () {
          await Promise.resolve();
          yield {
            type: "tool-approval-request",
            toolCallId: "call_allow",
            toolName: "bash",
          };
          yield {
            type: "tool-call",
            toolCallId: "call_allow",
            toolName: "bash",
            input: { command: "pwd" },
          };
          yield {
            type: "tool-approval-request",
            toolCallId: "call_deny",
            toolName: "bash",
          };
          yield {
            type: "tool-output-denied",
            toolCallId: "call_deny",
            toolName: "bash",
          };
          yield { type: "text-delta", text: "done" };
          yield { type: "finish-step", finishReason: "stop" };
        })() as unknown as AgentStreamResult["fullStream"],
        response: Promise.resolve({
          id: "mock-response",
          modelId: "mock-model",
          timestamp: new Date(),
          messages: [{ role: "assistant", content: "done" }],
        } as Awaited<AgentStreamResult["response"]>),
        totalUsage: Promise.resolve(
          undefined
        ) as unknown as AgentStreamResult["totalUsage"],
        usage: Promise.resolve(
          undefined
        ) as unknown as AgentStreamResult["usage"],
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "approval",
        state: "approved",
        toolCallId: "call_allow",
        toolName: "bash",
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "approval",
        state: "denied",
        toolCallId: "call_deny",
        toolName: "bash",
      })
    );
  });
});

describe("extractToolOutput", () => {
  it("returns string input as-is", () => {
    expect(extractToolOutput("hello")).toBe("hello");
  });

  it("returns empty string for null", () => {
    expect(extractToolOutput(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(extractToolOutput(undefined)).toBe("");
  });

  it("extracts string .output from CEA tool results", () => {
    expect(extractToolOutput({ output: "file contents" })).toBe(
      "file contents"
    );
  });

  it("serializes non-string .output values", () => {
    expect(extractToolOutput({ output: 42 })).toBe("42");
    expect(extractToolOutput({ output: { nested: true } })).toBe(
      '{"nested":true}'
    );
  });

  it("returns empty string for { output: '' }", () => {
    expect(extractToolOutput({ output: "" })).toBe("");
  });

  it("serializes MCP-style objects with content array", () => {
    const mcpResult = {
      content: [{ type: "text", text: "search results" }],
      structuredContent: { results: [] },
      isError: false,
    };
    const result = extractToolOutput(mcpResult);
    expect(typeof result).toBe("string");
    expect(JSON.parse(result)).toEqual(mcpResult);
  });

  it("handles non-serializable objects gracefully", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = extractToolOutput(circular);
    expect(typeof result).toBe("string");
  });

  it("handles { output: undefined } without returning non-string", () => {
    const result = extractToolOutput({ output: undefined });
    expect(typeof result).toBe("string");
  });

  it("handles symbol input", () => {
    const result = extractToolOutput(Symbol("x"));
    expect(typeof result).toBe("string");
  });

  it("handles function input", () => {
    const fn = (): void => undefined;
    const result = extractToolOutput(fn);
    expect(typeof result).toBe("string");
  });
});
