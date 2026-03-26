import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CheckpointHistory,
  isContextOverflowError,
} from "./checkpoint-history";
import { getContinuationText } from "./continuation";
import { SessionStore } from "./session-store";
import { estimateTokens } from "./token-utils";

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

    describe("with user request replay", () => {
      it("auto-compact: getMessagesForLLM has [summary, continuation, last_user_request]", async () => {
        const h = new CheckpointHistory({
          compaction: {
            enabled: true,
            summarizeFn: async () => "Summary of conversation",
          },
        });

        h.addUserMessage("initial message");
        h.addModelMessages([{ role: "assistant", content: "reply" }]);
        h.addUserMessage("LATEST USER REQUEST");

        await h.compact({ auto: true });

        const llmMsgs = h.getMessagesForLLM();
        expect(llmMsgs.length).toBeGreaterThanOrEqual(3);
        expect(llmMsgs[0]?.role).toBe("user");
        expect(llmMsgs[1]?.role).toBe("assistant");
        expect(llmMsgs[1]?.content).toBe(
          getContinuationText("auto-with-replay")
        );

        const lastIndex = llmMsgs.length - 1;
        const lastMsg = lastIndex >= 0 ? llmMsgs[lastIndex] : undefined;
        expect(lastMsg?.role).toBe("user");
        expect(lastMsg?.content).toBe("LATEST USER REQUEST");
      });

      it("manual-compact: NO replay, just [summary, continuation]", async () => {
        const h = new CheckpointHistory({
          compaction: {
            enabled: true,
            summarizeFn: async () => "Summary",
          },
        });

        h.addUserMessage("some message");
        h.addModelMessages([{ role: "assistant", content: "reply" }]);
        h.addUserMessage("this should NOT be replayed");

        await h.compact({ auto: false });

        const llmMsgs = h.getMessagesForLLM();
        expect(llmMsgs[0]?.role).toBe("user");
        expect(llmMsgs[1]?.role).toBe("assistant");
        expect(llmMsgs[1]?.content).toBe(getContinuationText("manual"));

        const userMsgs = llmMsgs.filter((m) => m.role === "user");
        expect(userMsgs).toHaveLength(1);
      });

      it("only text-only user messages are replayed (not tool-content messages)", async () => {
        const h = new CheckpointHistory({
          compaction: {
            enabled: true,
            summarizeFn: async () => "Summary",
          },
        });

        h.addModelMessages([
          {
            role: "user",
            content: [{ type: "text", text: "not plain string" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "1",
                toolName: "test",
                input: {},
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "1",
                toolName: "test",
                output: { type: "text", value: "result" },
              },
            ],
          },
        ]);

        await h.compact({ auto: true });

        const llmMsgs = h.getMessagesForLLM();
        expect(llmMsgs[0]?.role).toBe("user");
        expect(llmMsgs[1]?.role).toBe("assistant");
        expect(llmMsgs[1]?.content).toBe(getContinuationText("tool-loop"));

        const lastIndex = llmMsgs.length - 1;
        const lastMsg = lastIndex >= 0 ? llmMsgs[lastIndex] : undefined;
        expect(lastMsg?.role).not.toBe("user");
      });
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

  describe("handleContextOverflow()", () => {
    it("prune → compact escalation reduces tokens", async () => {
      const h = new CheckpointHistory({
        compaction: {
          enabled: true,
          maxTokens: 100,
          summarizeFn: async () => "Brief summary",
        },
        pruning: {
          enabled: true,
          minSavingsTokens: 1,
        },
      });

      for (let i = 0; i < 20; i++) {
        h.addUserMessage(`This is a fairly long message ${i}`);
      }

      const tokensBefore = h.getEstimatedTokens();
      const result = await h.handleContextOverflow();

      expect(result.success).toBe(true);
      expect(h.getEstimatedTokens()).toBeLessThan(tokensBefore);
      expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    });

    it("returns success=false if no reduction possible (disabled compaction)", async () => {
      const h = new CheckpointHistory({
        compaction: { enabled: false },
        pruning: { enabled: false },
      });
      h.addUserMessage("hello");

      const result = await h.handleContextOverflow();
      expect(result.success).toBe(false);
      expect(result.error).toContain("no reduction mechanism available");
    });

    it("ensures tokens are below contextLimit after recovery when contextLimit is set", async () => {
      const h = new CheckpointHistory({
        compaction: {
          enabled: true,
          contextLimit: 40,
          keepRecentTokens: 0,
          summarizeFn: async () => "short",
        },
        pruning: {
          enabled: true,
          minSavingsTokens: 1,
        },
      });

      for (let i = 0; i < 12; i++) {
        h.addUserMessage(`Long user message ${i} with many extra tokens`);
      }

      const result = await h.handleContextOverflow();
      expect(result.success).toBe(true);
      expect(h.getEstimatedTokens()).toBeLessThan(40);
    });

    it("returns success=false when all strategies fail (no throw)", async () => {
      const h = new CheckpointHistory({
        compaction: {
          enabled: true,
          contextLimit: 5,
          summarizeFn: async () => "this summary is still too long to fit",
        },
        pruning: { enabled: false },
      });

      h.addUserMessage("single very long message that cannot be removed");

      const result = await h.handleContextOverflow();
      expect(result.success).toBe(false);
      expect(result.error?.toLowerCase()).toContain("context");
    });
  });

  describe("isContextOverflowError()", () => {
    it("detects context length exceeded errors", () => {
      expect(isContextOverflowError(new Error("context_length_exceeded"))).toBe(
        true
      );
      expect(isContextOverflowError(new Error("network error"))).toBe(false);
      expect(isContextOverflowError(null)).toBe(false);
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

  describe("CheckpointHistory token tracking", () => {
    it("clear() resets messages to empty array", () => {
      const h = new CheckpointHistory();
      h.addUserMessage("hello");
      h.addUserMessage("world");
      h.clear();
      expect(h.getAll()).toHaveLength(0);
    });

    it("clear() resets summaryMessageId to null", async () => {
      const h = new CheckpointHistory({
        compaction: {
          enabled: true,
          keepRecentTokens: 0,
          summarizeFn: async () => "summary",
        },
      });
      h.addUserMessage("hello");
      h.addUserMessage("world");
      await h.compact();
      expect(h.getSummaryMessageId()).not.toBeNull();
      h.clear();
      expect(h.getSummaryMessageId()).toBeNull();
    });

    it("clear() increments revision", () => {
      const h = new CheckpointHistory();
      const revBefore = h.getRevision();
      h.clear();
      expect(h.getRevision()).toBeGreaterThan(revBefore);
    });

    it("updateActualUsage stores usage and getActualUsage retrieves it", () => {
      const h = new CheckpointHistory();
      h.updateActualUsage({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        updatedAt: new Date(),
      });
      const usage = h.getActualUsage();
      expect(usage).not.toBeNull();
      expect(usage?.promptTokens).toBe(100);
      expect(usage?.completionTokens).toBe(50);
      expect(usage?.totalTokens).toBe(150);
    });

    it("getActualUsage returns null when no usage recorded", () => {
      const h = new CheckpointHistory();
      expect(h.getActualUsage()).toBeNull();
    });

    it("clear() resets actual usage to null", () => {
      const h = new CheckpointHistory();
      h.updateActualUsage({
        promptTokens: 100,
        completionTokens: 0,
        totalTokens: 100,
        updatedAt: new Date(),
      });
      h.clear();
      expect(h.getActualUsage()).toBeNull();
    });

    it("getContextUsage returns source='estimated' before actual usage", () => {
      const h = new CheckpointHistory();
      h.addUserMessage("hello world");
      const usage = h.getContextUsage();
      expect(usage.source).toBe("estimated");
      expect(usage.used).toBeGreaterThan(0);
    });

    it("getContextUsage returns source='actual' after updateActualUsage", () => {
      const h = new CheckpointHistory();
      h.addUserMessage("hello");
      h.updateActualUsage({
        promptTokens: 42,
        completionTokens: 10,
        totalTokens: 52,
        updatedAt: new Date(),
      });
      const usage = h.getContextUsage();
      expect(usage.source).toBe("actual");
      expect(usage.used).toBe(42);
    });

    it("getContextUsage percentage is 0 when no context limit set", () => {
      const h = new CheckpointHistory();
      h.addUserMessage("hello");
      const usage = h.getContextUsage();
      expect(usage.percentage).toBe(0);
      expect(usage.limit).toBe(0);
    });
  });
});

describe("CheckpointHistory context limit methods", () => {
  it("setContextLimit / getContextLimit round-trip", () => {
    const h = new CheckpointHistory();
    expect(h.getContextLimit()).toBe(0);
    h.setContextLimit(100_000);
    expect(h.getContextLimit()).toBe(100_000);
  });

  it("setSystemPromptTokens / getSystemPromptTokens round-trip", () => {
    const h = new CheckpointHistory();
    expect(h.getSystemPromptTokens()).toBe(0);
    h.setSystemPromptTokens(500);
    expect(h.getSystemPromptTokens()).toBe(500);
  });

  it("isCompactionEnabled returns false by default", () => {
    const h = new CheckpointHistory();
    expect(h.isCompactionEnabled()).toBe(false);
  });

  it("isCompactionEnabled returns true when config.enabled=true", () => {
    const h = new CheckpointHistory({
      compaction: { enabled: true, summarizeFn: async () => "" },
    });
    expect(h.isCompactionEnabled()).toBe(true);
  });

  it("isPruningEnabled returns false by default", () => {
    const h = new CheckpointHistory();
    expect(h.isPruningEnabled()).toBe(false);
  });

  it("updateCompaction merges config", () => {
    const h = new CheckpointHistory({ compaction: { enabled: false } });
    h.updateCompaction({ enabled: true });
    expect(h.isCompactionEnabled()).toBe(true);
  });

  it("updatePruning enables pruning", () => {
    const h = new CheckpointHistory();
    expect(h.isPruningEnabled()).toBe(false);
    h.updatePruning({ enabled: true });
    expect(h.isPruningEnabled()).toBe(true);
  });

  it("needsCompaction returns false when disabled", () => {
    const h = new CheckpointHistory();
    expect(h.needsCompaction()).toBe(false);
  });

  it("isAtHardContextLimit returns false when no limit set", () => {
    const h = new CheckpointHistory();
    expect(h.isAtHardContextLimit()).toBe(false);
  });

  it("getRecommendedMaxOutputTokens returns default when no limit set", () => {
    const h = new CheckpointHistory();
    const n = h.getRecommendedMaxOutputTokens();
    expect(n).toBeGreaterThan(0);
  });

  it("shouldStartSpeculativeCompactionForNextTurn returns false by default", () => {
    const h = new CheckpointHistory();
    expect(h.shouldStartSpeculativeCompactionForNextTurn()).toBe(false);
  });
});

describe("CheckpointHistory structural conformance", () => {
  it("satisfies AgentTUIMessageHistory interface (compile-time)", () => {
    const h = new CheckpointHistory();
    const _: import("../../tui/src/agent-tui").AgentTUIMessageHistory = h;
    expect(_).toBeDefined();
  });
});

describe("handleContextOverflow() overflow recovery — RED", () => {
  it("verbose summary recovery should still succeed via rollback+truncate", async () => {
    const h = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 300,
        keepRecentTokens: 0,
        summarizeFn: async () => "verbose ".repeat(500),
      },
      pruning: { enabled: false },
    });

    h.addUserMessage("alpha ".repeat(200));
    h.addModelMessages([{ role: "assistant", content: "ack" }]);
    h.addUserMessage("beta ".repeat(200));

    const result = await h.handleContextOverflow();
    expect(result.success).toBe(true);
    expect(result.strategy).toBe("truncate");
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it("summary-only overflow after compact should return success=false instead of throwing", async () => {
    const h = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 20,
        keepRecentTokens: 0,
        summarizeFn: async () => "Y".repeat(200),
      },
      pruning: { enabled: false },
    });

    h.addUserMessage("request ".repeat(200));
    h.addModelMessages([
      { role: "assistant", content: "response ".repeat(200) },
    ]);

    const result = await h.handleContextOverflow();
    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("context");
  });

  it("single huge message should return success=false with context error, not throw", async () => {
    const h = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 50,
        summarizeFn: async () => "tiny",
      },
      pruning: { enabled: false },
    });

    h.addUserMessage("word ".repeat(5000));

    const result = await h.handleContextOverflow();
    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("context");
  });

  it("prune strategy should actually reduce tokens for large tool-result outputs", async () => {
    const hugeOutput = "very long output ".repeat(500);
    const expectedLargeOutputTokens = estimateTokens(hugeOutput);

    const h = new CheckpointHistory({
      compaction: { enabled: false },
      pruning: {
        enabled: true,
        minSavingsTokens: 1,
        protectRecentTokens: 0,
      },
    });

    h.addUserMessage("please read file");
    h.addModelMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read_file",
            output: { type: "text", value: hugeOutput },
          },
        ],
      },
    ]);

    expect(expectedLargeOutputTokens).toBeGreaterThan(1000);

    const result = await h.handleContextOverflow();
    expect(result.success).toBe(true);
    expect(result.strategy).toBe("prune");
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(h.getEstimatedTokens()).toBeLessThan(result.tokensBefore);
  });

  it("failed compact can still recover via later strategies", async () => {
    const h = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 20,
        keepRecentTokens: 0,
        summarizeFn: async () => "verbose ".repeat(500),
      },
      pruning: { enabled: false },
    });

    h.addUserMessage("one ".repeat(120));
    h.addModelMessages([{ role: "assistant", content: "reply one" }]);
    h.addUserMessage("two ".repeat(120));
    h.addModelMessages([{ role: "assistant", content: "reply two" }]);

    const result = await h.handleContextOverflow();
    expect(result.success).toBe(true);
  });

  it("should guard concurrent recoveries and reject second call immediately", async () => {
    const h = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 100,
        keepRecentTokens: 0,
        summarizeFn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return "short summary";
        },
      },
      pruning: { enabled: false },
    });

    for (let i = 0; i < 10; i++) {
      h.addUserMessage(`message ${i} ${"x ".repeat(80)}`);
    }

    const [first, second] = await Promise.all([
      h.handleContextOverflow(),
      h.handleContextOverflow(),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.error?.toLowerCase()).toContain("recovery in progress");
  });

  it("when all strategies fail should return success=false (nuclear exhausted) not throw", async () => {
    const h = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 25,
        keepRecentTokens: 0,
        summarizeFn: async () => "Z".repeat(300),
      },
      pruning: { enabled: false },
    });

    h.addUserMessage(`u1 ${"long ".repeat(80)}`);
    h.addModelMessages([
      { role: "assistant", content: `a1 ${"long ".repeat(80)}` },
    ]);
    h.addUserMessage(`u2 ${"long ".repeat(80)}`);
    h.addModelMessages([
      { role: "assistant", content: `a2 ${"long ".repeat(80)}` },
    ]);

    const result = await h.handleContextOverflow();
    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("context");
  });

  it("successful overflow recovery should clear actualUsage", async () => {
    const h = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 120,
        keepRecentTokens: 0,
        summarizeFn: async () => "brief summary",
      },
      pruning: { enabled: false },
    });

    for (let i = 0; i < 12; i++) {
      h.addUserMessage("payload ".repeat(50) + i);
    }

    h.updateActualUsage({
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      updatedAt: new Date(),
    });

    const result = await h.handleContextOverflow();
    expect(result.success).toBe(true);
    expect(h.getActualUsage()).toBeNull();
  });
});

describe("systemPromptTokens in estimated usage", () => {
  it("includes systemPromptTokens in estimated usage when actualUsage is null", () => {
    const h = new CheckpointHistory({
      compaction: { enabled: false, contextLimit: 0 },
    });

    // Add a short user message (~5 tokens via chars/4)
    h.addUserMessage("short message here"); // ~19 chars / 4 ≈ 5 tokens

    // Set system prompt tokens
    h.setSystemPromptTokens(500);

    // getContextUsage should include systemPromptTokens
    const usage = h.getContextUsage();
    expect(usage.source).toBe("estimated");
    // Current code: usage.used = getEstimatedTokens() (does NOT include 500)
    // Expected after fix: usage.used = getEstimatedTokens() + 500
    expect(usage.used).toBeGreaterThanOrEqual(505); // at least 500 systemPrompt + ~5 message tokens
  });

  it("does NOT double-count systemPromptTokens when actualUsage is available", () => {
    const h = new CheckpointHistory({
      compaction: { enabled: false, contextLimit: 0 },
    });

    // Set actual usage from API (already includes system prompt in API's total)
    h.updateActualUsage({
      promptTokens: 4800,
      completionTokens: 200,
      totalTokens: 5000,
      updatedAt: new Date(),
    });

    // Set system prompt tokens
    h.setSystemPromptTokens(500);

    const usage = h.getContextUsage();
    expect(usage.source).toBe("actual");
    // Must be exactly 4800 (promptTokens from actual, NO +500 double-count)
    // getContextUsage actual branch uses: this.actualUsage.promptTokens ?? this.actualUsage.totalTokens
    expect(usage.used).toBe(4800);
  });

  it("triggers hard context limit accounting for systemPromptTokens", () => {
    // contextLimit=110, reserve=2
    // Message tokens ≈ 20 (80 chars / 4 = 20)
    // systemPromptTokens = 90
    // Total estimated = 20 + 90 = 110
    // Hard limit: 110 + 0 + 2 >= 110 → should be TRUE after fix
    const h = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 110,
        reserveTokens: 2,
        summarizeFn: async () => "summary",
      },
    });

    h.addUserMessage("a".repeat(80)); // ~80 chars / 4 = 20 tokens
    h.setSystemPromptTokens(90);

    // Current code: getCurrentUsageTokens() = estimateTokens(msg) ≈ 20, NOT including 90
    // So 20 + 0 + 2 = 22 < 110 → FALSE (test fails - RED ✓)
    // After fix: 20 + 90 + 0 + 2 = 112 >= 110 → TRUE
    expect(h.isAtHardContextLimit()).toBe(true);
  });
});
