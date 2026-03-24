import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointHistory } from "./checkpoint-history";
import { SessionStore } from "./session-store";

describe("CheckpointHistory", () => {
  describe("addUserMessage", () => {
    it("returns CheckpointMessage with id, role user, createdAt", () => {
      const h = new CheckpointHistory();
      const msg = h.addUserMessage("hello world");

      expect(msg.id).toBeTruthy();
      expect(msg.message.role).toBe("user");
      expect(msg.message.content).toBe("hello world");
      expect(msg.createdAt).toBeGreaterThan(0);
      expect(msg.isSummary).toBe(false);
    });

    it("generates unique IDs for each message", () => {
      const h = new CheckpointHistory();
      const m1 = h.addUserMessage("a");
      const m2 = h.addUserMessage("b");

      expect(m1.id).not.toBe(m2.id);
    });

    it("preserves originalContent when provided", () => {
      const h = new CheckpointHistory();
      const msg = h.addUserMessage("processed", "original");

      expect(msg.originalContent).toBe("original");
    });
  });

  describe("addModelMessages", () => {
    it("returns array of CheckpointMessages", () => {
      const h = new CheckpointHistory();
      const msgs = h.addModelMessages([
        { role: "assistant", content: "hello" },
        { role: "user", content: "world" },
      ]);

      expect(msgs).toHaveLength(2);
      expect(msgs[0]?.message.role).toBe("assistant");
      expect(msgs[1]?.message.role).toBe("user");
    });
  });

  describe("getAll", () => {
    it("returns all messages in insertion order", () => {
      const h = new CheckpointHistory();
      h.addUserMessage("first");
      h.addUserMessage("second");
      h.addUserMessage("third");

      const all = h.getAll();
      expect(all).toHaveLength(3);
      expect(all[0]?.message.content).toBe("first");
      expect(all[2]?.message.content).toBe("third");
    });

    it("returns empty array for empty history", () => {
      const h = new CheckpointHistory();
      expect(h.getAll()).toEqual([]);
    });
  });

  describe("toModelMessages", () => {
    it("converts CheckpointMessages to ModelMessages", () => {
      const h = new CheckpointHistory();
      h.addUserMessage("hello");

      const msgs = h.toModelMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("user");
      expect(msgs[0]?.content).toBe("hello");
    });
  });

  describe("getMessagesForLLM", () => {
    it("returns all messages when no checkpoint set", () => {
      const h = new CheckpointHistory();
      h.addUserMessage("hello");
      h.addModelMessages([{ role: "assistant", content: "world" }]);

      const msgs = h.getMessagesForLLM();
      expect(msgs).toHaveLength(2);
    });
  });

  describe("compact()", () => {
    it("creates checkpoint — getMessagesForLLM returns [summary_as_user, ...newer_messages]", async () => {
      let summarizeCalled = false;
      const h = new CheckpointHistory({
        compaction: {
          enabled: true,
          summarizeFn: () => {
            summarizeCalled = true;
            return Promise.resolve("Summary of conversation");
          },
        },
      });

      h.addUserMessage("message 1");
      h.addModelMessages([{ role: "assistant", content: "reply 1" }]);
      h.addUserMessage("message 2");

      const result = await h.compact();
      expect(result.success).toBe(true);
      expect(summarizeCalled).toBe(true);

      const llmMessages = h.getMessagesForLLM();
      expect(llmMessages[0]?.role).toBe("user");
      expect(
        typeof llmMessages[0]?.content === "string" && llmMessages[0].content
      ).toBeTruthy();
      expect(llmMessages.length).toBeGreaterThan(1);

      const all = h.getAll();
      expect(all.length).toBeGreaterThan(1);
    });

    it("getAll() returns ALL messages including pre-checkpoint after compact", async () => {
      const h = new CheckpointHistory({
        compaction: {
          enabled: true,
          summarizeFn: async () => "summary",
        },
      });

      h.addUserMessage("a");
      h.addUserMessage("b");
      h.addUserMessage("c");
      const totalBefore = h.getAll().length;

      await h.compact();

      const totalAfter = h.getAll().length;
      expect(totalAfter).toBeGreaterThan(totalBefore);

      const contents = h
        .getAll()
        .map((m) =>
          typeof m.message.content === "string" ? m.message.content : ""
        );
      expect(contents).toContain("a");
      expect(contents).toContain("b");
    });

    it("summary stored as assistant, returned as user in getMessagesForLLM", async () => {
      const h = new CheckpointHistory({
        compaction: {
          enabled: true,
          summarizeFn: async () => "Summary text",
        },
      });

      h.addUserMessage("hello");
      h.addUserMessage("world");
      await h.compact();

      const summaryInStorage = h.getAll().find((m) => m.isSummary);
      expect(summaryInStorage).toBeDefined();
      expect(summaryInStorage?.message.role).toBe("assistant");

      const llmMsgs = h.getMessagesForLLM();
      const summaryInLLM = llmMsgs.find(
        (m) => typeof m.content === "string" && m.content === "Summary text"
      );
      expect(summaryInLLM?.role).toBe("user");
    });

    it("invalid summaryMessageId falls back to full history", () => {
      const h = new CheckpointHistory();
      h.addUserMessage("hello");

      Object.defineProperty(h, "summaryMessageId", {
        value: "nonexistent-id",
        configurable: true,
      });

      const msgs = h.getMessagesForLLM();
      expect(msgs.length).toBe(1);
    });

    it("multiple compactions pass previousSummary to summarizeFn", async () => {
      let previousSummarySeen: string | undefined;

      const h = new CheckpointHistory({
        compaction: {
          enabled: true,
          keepRecentTokens: 30,
          summarizeFn: (_msgs, previousSummary) => {
            previousSummarySeen = previousSummary;
            return Promise.resolve(
              previousSummary ? `${previousSummary} + refined` : "first summary"
            );
          },
        },
      });

      h.addUserMessage("a ".repeat(200));
      h.addUserMessage("b ".repeat(200));
      h.addUserMessage("c ".repeat(200));
      await h.compact();

      h.addUserMessage("d ".repeat(200));
      h.addUserMessage("e ".repeat(200));
      await h.compact();

      expect(previousSummarySeen).toBe("first summary");
    });

    it("getEstimatedTokens() decreases after compact", async () => {
      const h = new CheckpointHistory({
        compaction: {
          enabled: true,
          summarizeFn: () => Promise.resolve("Brief summary"),
        },
      });

      for (let i = 0; i < 10; i++) {
        h.addUserMessage(
          `This is a long message with many words that will take up tokens in the context window ${i}`
        );
        h.addModelMessages([
          {
            role: "assistant",
            content: `This is an equally long reply to the message ${i}`,
          },
        ]);
      }

      const tokensBefore = h.getEstimatedTokens();
      await h.compact();
      const tokensAfter = h.getEstimatedTokens();

      expect(tokensAfter).toBeLessThan(tokensBefore);
    });

    it("increments revision on each successful compaction", async () => {
      const h = new CheckpointHistory({
        compaction: {
          enabled: true,
          summarizeFn: async () => "summary",
        },
      });

      h.addUserMessage("one");
      h.addUserMessage("two");
      const before = h.getRevision();

      const first = await h.compact();
      const afterFirst = h.getRevision();
      expect(first.success).toBe(true);
      expect(afterFirst).toBe(before + 1);

      h.addUserMessage("three ".repeat(200));
      h.addUserMessage("four ".repeat(200));
      const beforeSecond = h.getRevision();
      const second = await h.compact();
      const afterSecond = h.getRevision();
      expect(second.success).toBe(true);
      expect(afterSecond).toBe(beforeSecond + 1);
    });

    it("persists checkpoint via SessionStore.updateCheckpoint", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "ch-compact-"));
      const store = new SessionStore(tmpDir);
      const h = new CheckpointHistory({
        sessionId: "compact-persist",
        sessionStore: store,
        compaction: {
          enabled: true,
          summarizeFn: async () => "persisted summary",
        },
      });

      h.addUserMessage("hello");
      h.addUserMessage("world");
      const result = await h.compact();
      expect(result.success).toBe(true);

      const loaded = await store.loadSession("compact-persist");
      expect(loaded?.summaryMessageId).toBe(result.summaryMessageId);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns false when compact() called with no messages", async () => {
      const h = new CheckpointHistory({
        compaction: { enabled: true, summarizeFn: async () => "" },
      });

      const result = await h.compact();
      expect(result.success).toBe(false);
    });

    it("returns false when compaction is disabled", async () => {
      const h = new CheckpointHistory({ compaction: { enabled: false } });
      h.addUserMessage("hello");

      const result = await h.compact();
      expect(result.success).toBe(false);
    });
  });

  describe("tool-call/result sequence validation", () => {
    it("removes orphaned tool-result without preceding tool-call", () => {
      const h = new CheckpointHistory();

      h.addModelMessages([
        { role: "user", content: "request" },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "orphaned",
              toolName: "test",
              output: { type: "text", value: "orphan" },
            },
          ],
        },
      ]);

      const msgs = h.getMessagesForLLM();
      const toolMsgs = msgs.filter((m) => m.role === "tool");
      expect(toolMsgs).toHaveLength(0);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.role).toBe("user");
    });

    it("removes assistant tool-call without following tool-result", () => {
      const h = new CheckpointHistory();

      h.addModelMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "read_file",
              input: { path: "foo.ts" },
            },
          ],
        },
        { role: "assistant", content: "next response" },
      ]);

      const msgs = h.getMessagesForLLM();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toEqual({ role: "assistant", content: "next response" });
    });
  });

  describe("persistence", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "ch-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("persists messages to JSONL when SessionStore provided", async () => {
      const store = new SessionStore(tmpDir);
      const h = new CheckpointHistory({
        sessionId: "test-session",
        sessionStore: store,
      });

      h.addUserMessage("persist me");

      const loaded = await store.loadSession("test-session");
      expect(loaded).not.toBeNull();
      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.messages[0]?.message.content).toBe("persist me");
    });

    it("works without SessionStore (in-memory only)", () => {
      const h = new CheckpointHistory();
      h.addUserMessage("in memory");
      expect(h.getAll()).toHaveLength(1);
    });
  });
});
