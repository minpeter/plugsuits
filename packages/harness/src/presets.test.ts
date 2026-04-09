import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryAgent, createSessionAgent } from "./presets";
import { SessionStore } from "./session-store";
import type { MemoryAgentConfig } from "./presets";

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

vi.mock("ai", () => ({
  stepCountIs: vi.fn(() => undefined),
  streamText: streamTextMock,
}));

function createMockModel(): MemoryAgentConfig["model"] {
  return {} as MemoryAgentConfig["model"];
}

describe("presets", () => {
  beforeEach(() => {
    streamTextMock.mockClear();
  });

  it("createMemoryAgent returns agent and history", async () => {
    const result = createMemoryAgent({ model: createMockModel() });

    expect(result.agent).toBeTruthy();
    expect(result.history).toBeTruthy();
    expect(typeof result.agent.stream).toBe("function");

    await result.agent.stream({ messages: [] });

    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("createMemoryAgent history starts empty", () => {
    const result = createMemoryAgent({ model: createMockModel() });

    expect(result.history.getAll()).toEqual([]);
  });

  it("createSessionAgent loads from existing session if provided", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harness-presets-"));

    try {
      const store = new SessionStore(tempDir);
      const sessionId = "session-123";

      await store.appendMessage(sessionId, {
        type: "message",
        id: "msg-1",
        createdAt: Date.now(),
        isSummary: false,
        originalContent: undefined,
        message: {
          role: "user",
          content: "hello from persisted session",
        },
      });

      const result = await createSessionAgent({
        model: createMockModel(),
        sessionId,
        store,
      });

      expect(result.history.getAll()).toHaveLength(1);
      expect(result.history.toModelMessages()).toEqual([
        { role: "user", content: "hello from persisted session" },
      ]);
      await expect(result.save()).resolves.toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
