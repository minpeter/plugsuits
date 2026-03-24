import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session-store";

describe("SessionStore", () => {
  let tmpDir: string;
  let store: SessionStore;

  const expectSessionData = <T>(value: T | null): T => {
    if (value === null) {
      throw new Error("Expected session data");
    }
    return value;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-store-test-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it("returns null for non-existent session", async () => {
    const result = await store.loadSession("nonexistent");
    expect(result).toBeNull();
  });

  it("round-trip: 10 messages survive write→read", async () => {
    const sessionId = "test-session-1";

    for (let i = 0; i < 10; i++) {
      await store.appendMessage(sessionId, {
        type: "message",
        id: `msg-${i}`,
        createdAt: Date.now(),
        isSummary: false,
        message: { role: "user", content: `message ${i}` },
      });
    }

    const result = expectSessionData(await store.loadSession(sessionId));
    expect(result.messages).toHaveLength(10);
    expect(result.messages[0].id).toBe("msg-0");
    expect(result.messages[9].id).toBe("msg-9");
  });

  it("checkpoint: updateCheckpoint updates summaryMessageId", async () => {
    const sessionId = "test-session-2";

    await store.appendMessage(sessionId, {
      type: "message",
      id: "msg-1",
      createdAt: Date.now(),
      isSummary: false,
      message: { role: "user", content: "hello" },
    });

    await store.updateCheckpoint(sessionId, "msg-1");

    const result = expectSessionData(await store.loadSession(sessionId));
    expect(result.summaryMessageId).toBe("msg-1");
  });

  it("corruption: truncated last line is skipped, rest loaded", async () => {
    const sessionId = "test-session-3";

    await store.appendMessage(sessionId, {
      type: "message",
      id: "msg-1",
      createdAt: Date.now(),
      isSummary: false,
      message: { role: "user", content: "first" },
    });

    await store.appendMessage(sessionId, {
      type: "message",
      id: "msg-2",
      createdAt: Date.now(),
      isSummary: false,
      message: { role: "assistant", content: "second" },
    });

    const filePath = join(tmpDir, `${sessionId}.jsonl`);
    appendFileSync(filePath, '{"type":"message","id":"corrupt-line-incomplete');

    const result = expectSessionData(await store.loadSession(sessionId));
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].id).toBe("msg-2");
  });

  it("multiple checkpoints: latest checkpoint wins", async () => {
    const sessionId = "test-session-4";

    await store.appendMessage(sessionId, {
      type: "message",
      id: "msg-1",
      createdAt: Date.now(),
      isSummary: false,
      message: { role: "user", content: "hello" },
    });
    await store.updateCheckpoint(sessionId, "msg-1");

    await store.appendMessage(sessionId, {
      type: "message",
      id: "msg-2",
      createdAt: Date.now(),
      isSummary: true,
      message: { role: "user", content: "summary" },
    });
    await store.updateCheckpoint(sessionId, "msg-2");

    const result = expectSessionData(await store.loadSession(sessionId));
    expect(result.summaryMessageId).toBe("msg-2");
  });
});
