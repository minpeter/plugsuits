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
      sessionId: "timeout-case",
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
        sessionId: "timeout-case",
        error: "Error: Stream response timeout",
      }),
    ]);
  }, 35_000);
});
