import type { AgentStreamResult } from "@ai-sdk-tool/harness";
import { describe, expect, it } from "vitest";
import { processStream } from "./stream-processor";
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
