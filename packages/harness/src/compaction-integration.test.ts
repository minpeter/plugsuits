import { describe, expect, it } from "bun:test";
import { MessageHistory } from "./message-history";

/**
 * Integration tests for compaction logic with model-specific token limits.
 *
 * Simulates the compaction config that AgentManager.buildCompactionConfig()
 * would produce for different model configurations.
 *
 * Token estimation: improved estimator that accounts for CJK characters.
 * Latin: ~4 chars/token, CJK: ~1.5 chars/token
 */

// ─── Model configs (mirrors what buildCompactionConfig produces) ───

/** test-8k: contextLength=8192, effectiveMaxOutput=min(1024,64000)=1024 */
const TEST_8K_CONFIG = {
  enabled: true,
  maxTokens: 8192,
  reserveTokens: 1024,
  keepRecentTokens: Math.floor(8192 * 0.3), // 2457
} as const;

/** GLM-5: contextLength=202752, effectiveMaxOutput=min(202752,64000)=64000 */
const GLM5_CONFIG = {
  enabled: true,
  maxTokens: 202_752,
  reserveTokens: 64_000,
  keepRecentTokens: Math.floor(202_752 * 0.3), // 60825
} as const;
const SUMMARY_ID_REGEX = /^summary_/;

// ─── Helpers ───

const CHARS_PER_TOKEN = 4;
interface CompactionPreset {
  enabled: true;
  keepRecentTokens: number;
  maxTokens: number;
  reserveTokens: number;
}

/** Create a message string of approximately `tokenCount` tokens (Latin text). */
function makeContent(tokenCount: number): string {
  return "x".repeat(tokenCount * CHARS_PER_TOKEN);
}

function createHistory(compaction: CompactionPreset) {
  return new MessageHistory({ compaction });
}

/**
 * Create a history with auto-compaction disabled.
 * Messages are added freely, then compact() is called manually.
 */
function createHistoryManual(compaction: CompactionPreset) {
  return new MessageHistory({
    compaction: { ...compaction, enabled: false },
  });
}

function enableCompaction(history: MessageHistory, config: CompactionPreset) {
  history.updateCompaction({ ...config, enabled: true });
}

// ─── Tests ───

describe("compaction integration with model-specific configs", () => {
  describe("test-8k model (contextLength=8192, maxOutput=1024)", () => {
    // Trigger threshold: totalTokens > maxTokens - reserveTokens = 8192 - 1024 = 7168

    it("does NOT trigger compaction below threshold", () => {
      const history = createHistory(TEST_8K_CONFIG);

      // Add 7 messages of ~1000 tokens each = ~7000 tokens (below 7168)
      for (let i = 0; i < 7; i++) {
        history.addUserMessage(makeContent(1000));
      }

      // Use needsCompaction() for synchronous check
      expect(history.needsCompaction()).toBe(false);
      expect(history.getSummaries()).toHaveLength(0);
      expect(history.getAll().length).toBe(7);
    });

    it("DOES trigger compaction above threshold via compact()", async () => {
      const history = createHistory(TEST_8K_CONFIG);

      // Add 8 messages of ~1000 tokens each = ~8000 tokens (above 7168)
      for (let i = 0; i < 8; i++) {
        history.addUserMessage(makeContent(1000));
      }

      // Compaction is no longer fire-and-forget — use explicit compact()
      expect(history.needsCompaction()).toBe(true);
      await history.compact();

      // Should have compacted
      expect(history.getSummaries().length).toBeGreaterThanOrEqual(1);
      // Messages should be reduced
      expect(history.getAll().length).toBeLessThan(8);
    });

    it("DOES trigger compaction via prepare/apply flow", async () => {
      const history = createHistory(TEST_8K_CONFIG);

      // Add 8 messages of ~1000 tokens each = ~8000 tokens (above 7168)
      for (let i = 0; i < 8; i++) {
        history.addUserMessage(makeContent(1000));
      }

      // Use prepareSpeculativeCompaction + applyPreparedCompaction instead of getMessagesForLLMAsync
      const prepared = await history.prepareSpeculativeCompaction({
        phase: "new-turn",
      });
      expect(prepared).not.toBeNull();
      if (prepared) {
        history.applyPreparedCompaction(prepared);
      }

      // Should have compacted and prepended system summary
      expect(history.getSummaries().length).toBeGreaterThanOrEqual(1);
      const messages = history.getMessagesForLLM();
      expect(messages[0].role).toBe("system");
    });

    it("preserves recent messages within keepRecentTokens budget", async () => {
      const history = createHistoryManual(TEST_8K_CONFIG);

      const messages: string[] = [];
      for (let i = 0; i < 10; i++) {
        const content = `msg_${i}_${makeContent(990)}`;
        messages.push(content);
        history.addUserMessage(content);
      }

      enableCompaction(history, TEST_8K_CONFIG);
      await history.compact();

      const remaining = history.getAll();
      const summaries = history.getSummaries();

      expect(summaries.length).toBeGreaterThanOrEqual(1);

      const remainingContents = remaining.map((m) =>
        typeof m.modelMessage.content === "string" ? m.modelMessage.content : ""
      );

      // keepRecentTokens = 2457 tokens, each msg ~1000 tokens → ~2 kept
      expect(remaining.length).toBeGreaterThanOrEqual(2);
      expect(remaining.length).toBeLessThanOrEqual(3);

      // Last remaining must be the most recent message
      // biome-ignore lint/style/useAtIndex: Array.at() not available in this TypeScript target
      const lastRemaining = remainingContents[remainingContents.length - 1];
      expect(lastRemaining).toContain("msg_9_");
    });

    it("includes summaries in getMessagesForLLM()", async () => {
      const history = createHistory(TEST_8K_CONFIG);

      // Add messages above threshold
      for (let i = 0; i < 10; i++) {
        history.addUserMessage(makeContent(1000));
      }

      // Explicitly compact
      await history.compact();

      const llmMessages = history.getMessagesForLLM();
      const regularMessages = history.toModelMessages();

      // LLM messages should have a system message prepended with the summary
      expect(llmMessages.length).toBeGreaterThan(regularMessages.length);
      expect(llmMessages[0].role).toBe("system");
      expect(llmMessages[0].content).toContain(
        "Previous conversation context:"
      );
    });

    it("summary records correct metadata", async () => {
      const history = createHistory(TEST_8K_CONFIG);

      for (let i = 0; i < 10; i++) {
        history.addUserMessage(`Message ${i}: ${makeContent(990)}`);
      }

      // Explicitly compact
      await history.compact();

      const summaries = history.getSummaries();
      expect(summaries.length).toBeGreaterThanOrEqual(1);

      const summary = summaries[0];
      expect(summary.id).toMatch(SUMMARY_ID_REGEX);
      expect(summary.tokensBefore).toBeGreaterThan(0);
      expect(summary.summaryTokens).toBeGreaterThan(0);
      // Summary tokens should be much less than original
      expect(summary.summaryTokens).toBeLessThan(summary.tokensBefore);
      expect(summary.firstKeptMessageId).toBeTruthy();
    });

    it("handles updateCompaction correctly (model switch simulation)", async () => {
      const history = createHistory(TEST_8K_CONFIG);

      // Fill with some messages
      for (let i = 0; i < 5; i++) {
        history.addUserMessage(makeContent(1000));
      }

      // Should not compact yet (5000 < 7168)
      expect(history.needsCompaction()).toBe(false);
      expect(history.getSummaries()).toHaveLength(0);

      // Simulate switching to a model with a tiny context
      history.updateCompaction({
        maxTokens: 4000,
        reserveTokens: 500,
        keepRecentTokens: 1200,
      });

      // Now manually compact — threshold is now 4000-500=3500, we have ~5000
      expect(history.needsCompaction()).toBe(true);
      const compacted = await history.compact();
      expect(compacted).toBe(true);
      expect(history.getSummaries().length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("threshold boundary precision", () => {
    it("does NOT compact at exactly the threshold", () => {
      // Threshold = maxTokens - reserveTokens = 8192 - 1024 = 7168
      // We need totalTokens < 7168
      const history = createHistory(TEST_8K_CONFIG);

      // 7 messages of ~1000 tokens = ~7000 tokens (below 7168)
      for (let i = 0; i < 7; i++) {
        history.addUserMessage(makeContent(1000));
      }

      expect(history.needsCompaction()).toBe(false);
      expect(history.getSummaries()).toHaveLength(0);
    });

    it("DOES compact just above the threshold", async () => {
      // Push just past 7168 tokens
      const history = createHistory(TEST_8K_CONFIG);

      for (let i = 0; i < 7; i++) {
        history.addUserMessage(makeContent(1000));
      }
      // Add one more message to push past threshold
      history.addUserMessage(makeContent(200));
      // Total: ~7200 tokens > 7168

      expect(history.needsCompaction()).toBe(true);
      await history.compact();

      expect(history.getSummaries().length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GLM-5 model sanity check (large context)", () => {
    it("does NOT trigger compaction prematurely with large context", () => {
      const history = createHistory(GLM5_CONFIG);

      // Add 50 messages of ~1000 tokens = ~50000 tokens
      // Threshold: 202752 - 64000 = 138752
      // 50000 is way below 138752
      for (let i = 0; i < 50; i++) {
        history.addUserMessage(makeContent(1000));
      }

      expect(history.needsCompaction()).toBe(false);
      expect(history.getSummaries()).toHaveLength(0);
      expect(history.getAll().length).toBe(50);
    });
  });

  describe("compaction config via getCompactionConfig/updateCompaction", () => {
    it("getCompactionConfig returns current config", () => {
      const history = createHistory(TEST_8K_CONFIG);
      const config = history.getCompactionConfig();

      expect(config.enabled).toBe(true);
      expect(config.maxTokens).toBe(8192);
      expect(config.reserveTokens).toBe(1024);
      expect(config.keepRecentTokens).toBe(Math.floor(8192 * 0.3));
    });

    it("updateCompaction changes the config", () => {
      const history = createHistory(TEST_8K_CONFIG);

      history.updateCompaction({ maxTokens: 4000, reserveTokens: 500 });

      const config = history.getCompactionConfig();
      expect(config.maxTokens).toBe(4000);
      expect(config.reserveTokens).toBe(500);
      // Unchanged fields stay the same
      expect(config.keepRecentTokens).toBe(Math.floor(8192 * 0.3));
      expect(config.enabled).toBe(true);
    });
  });

  describe("tool-call/tool-result pair preservation during compaction", () => {
    it("does not split tool-call from its tool-result", async () => {
      const history = new MessageHistory({
        compaction: {
          enabled: true,
          maxTokens: 200,
          keepRecentTokens: 50,
          reserveTokens: 50,
        },
      });

      // Add messages: user, assistant(tool-call), tool(result), user, assistant
      history.addUserMessage(
        "First message with enough content to exceed limits easily"
      );
      history.addModelMessages([
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call_1",
              toolName: "read_file",
              input: { path: "test.ts" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "call_1",
              toolName: "read_file",
              output: {
                type: "text" as const,
                value: "file contents that are long enough",
              },
            },
          ],
        },
      ]);
      history.addUserMessage("Recent user message");
      history.addModelMessages([
        { role: "assistant" as const, content: "Recent assistant response" },
      ]);

      await history.compact();

      const msgs = history.toModelMessages();
      // Verify no orphaned tool results
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role === "tool") {
          expect(i).toBeGreaterThan(0);
          expect(msgs[i - 1].role).toBe("assistant");
        }
      }
    });
  });

  describe("iterative compaction (previousSummary)", () => {
    it("passes previousSummary to summarizeFn on second compaction", async () => {
      let receivedPreviousSummary: string | undefined;
      let callCount = 0;

      // biome-ignore lint/suspicious/useAwait: summarizeFn must return Promise<string> per API contract
      const customSummarizeFn = async (
        _messages: unknown[],
        previousSummary?: string
      ) => {
        callCount++;
        receivedPreviousSummary = previousSummary;
        return `Summary #${callCount}${previousSummary ? ` (updated from: ${previousSummary.slice(0, 50)})` : ""}`;
      };

      const history = new MessageHistory({
        compaction: {
          enabled: true,
          maxTokens: 400,
          keepRecentTokens: 100,
          reserveTokens: 100,
          summarizeFn: customSummarizeFn,
        },
      });

      // First compaction
      for (let i = 0; i < 5; i++) {
        history.addUserMessage("x".repeat(400));
      }
      await history.compact();

      expect(callCount).toBe(1);
      expect(receivedPreviousSummary).toBeUndefined();
      expect(history.getSummaries()).toHaveLength(1);
      const firstSummary = history.getSummaries()[0].summary;
      expect(firstSummary).toContain("Summary #1");

      // Add more messages for second compaction
      for (let i = 0; i < 5; i++) {
        history.addUserMessage("y".repeat(400));
      }
      await history.compact();

      expect(callCount).toBe(2);
      // Second call should have received the first summary as previousSummary
      expect(receivedPreviousSummary).toBeDefined();
      expect(receivedPreviousSummary).toContain("Summary #1");

      // After second compaction, summaries should be merged into 1
      expect(history.getSummaries()).toHaveLength(1);
      const mergedSummary = history.getSummaries()[0].summary;
      expect(mergedSummary).toContain("Summary #2");
      expect(mergedSummary).toContain("updated from:");
    });

    it("merges multiple summaries into one after compaction", async () => {
      let callCount = 0;
      // biome-ignore lint/suspicious/useAwait: summarizeFn must return Promise<string> per API contract
      const customSummarizeFn = async (
        _messages: unknown[],
        _previousSummary?: string
      ) => {
        callCount++;
        return `Iteration ${callCount}`;
      };

      const history = new MessageHistory({
        compaction: {
          enabled: true,
          maxTokens: 400,
          keepRecentTokens: 100,
          reserveTokens: 100,
          summarizeFn: customSummarizeFn,
        },
      });

      // Run 3 compaction cycles
      for (let cycle = 0; cycle < 3; cycle++) {
        for (let i = 0; i < 5; i++) {
          history.addUserMessage("z".repeat(400));
        }
        await history.compact();
      }

      // Should always have exactly 1 summary (merged)
      expect(history.getSummaries()).toHaveLength(1);
      expect(callCount).toBe(3);
      // The last summary should be the final iteration
      expect(history.getSummaries()[0].summary).toBe("Iteration 3");
    });

    it("defaultSummarizeFn includes previous context when provided", async () => {
      const history = new MessageHistory({
        compaction: {
          enabled: true,
          maxTokens: 400,
          keepRecentTokens: 100,
          reserveTokens: 100,
          // Use default summarizeFn (no custom)
        },
      });

      // First compaction
      for (let i = 0; i < 5; i++) {
        history.addUserMessage(`First batch message ${i}: ${"a".repeat(300)}`);
      }
      await history.compact();

      const firstSummary = history.getSummaries()[0].summary;
      expect(firstSummary).toContain("Previous conversation summary:");

      // Second compaction — should include previous context
      for (let i = 0; i < 5; i++) {
        history.addUserMessage(`Second batch message ${i}: ${"b".repeat(300)}`);
      }
      await history.compact();

      const secondSummary = history.getSummaries()[0].summary;
      expect(secondSummary).toContain("Previous Context:");
      expect(history.getSummaries()).toHaveLength(1);
    });

    it("backwards compatible — summarizeFn without previousSummary still works", async () => {
      // Simulate a user who defined summarizeFn with only 1 parameter
      // biome-ignore lint/suspicious/useAwait: summarizeFn must return Promise<string> per API contract
      const oldStyleSummarizeFn = async (messages: unknown[]) => {
        return `Old-style summary of ${messages.length} messages`;
      };

      const history = new MessageHistory({
        compaction: {
          enabled: true,
          maxTokens: 400,
          keepRecentTokens: 100,
          reserveTokens: 100,
          summarizeFn: oldStyleSummarizeFn,
        },
      });

      // First compaction
      for (let i = 0; i < 5; i++) {
        history.addUserMessage("x".repeat(400));
      }
      const result1 = await history.compact();
      expect(result1).toBe(true);

      // Second compaction — should not crash even though fn ignores 2nd param
      for (let i = 0; i < 5; i++) {
        history.addUserMessage("y".repeat(400));
      }
      const result2 = await history.compact();
      expect(result2).toBe(true);
      expect(history.getSummaries()).toHaveLength(1);
    });
  });

  describe("non-blocking compaction integration", () => {
    it("messages survive during in-flight compaction", async () => {
      const history = new MessageHistory({
        compaction: {
          enabled: true,
          maxTokens: 600,
          reserveTokens: 100,
          keepRecentTokens: 120,
          summarizeFn: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return "In-flight summary";
          },
        },
      });
      history.setContextLimit(600);

      for (let i = 0; i < 6; i++) {
        history.addUserMessage(`base_${i}_${makeContent(120)}`);
      }
      history.updateActualUsage({ totalTokens: 560 });

      const preparePromise = history.prepareSpeculativeCompaction({
        phase: "new-turn",
      });

      history.addUserMessage("tail_user_1");
      history.addUserMessage("tail_user_2");
      history.addUserMessage("tail_user_3");

      const prepared = await preparePromise;
      expect(prepared).not.toBeNull();

      // biome-ignore lint/style/noNonNullAssertion: prepared is asserted non-null above
      const applied = history.applyPreparedCompaction(prepared!);
      expect(applied).toEqual({ applied: true, reason: "applied" });

      const llmMessages = history.getMessagesForLLM();
      const textContents = llmMessages.flatMap((message) =>
        typeof message.content === "string" ? [message.content] : []
      );

      expect(
        textContents.some((content) => content.includes("tail_user_1"))
      ).toBe(true);
      expect(
        textContents.some((content) => content.includes("tail_user_2"))
      ).toBe(true);
      expect(
        textContents.some((content) => content.includes("tail_user_3"))
      ).toBe(true);
    });

    it("stale compaction rejected after contextLimit change", async () => {
      const history = new MessageHistory({
        compaction: {
          enabled: true,
          maxTokens: 1000,
          reserveTokens: 100,
          keepRecentTokens: 200,
          summarizeFn: async () => "Stale check summary",
        },
      });
      history.setContextLimit(1000);

      for (let i = 0; i < 5; i++) {
        history.addUserMessage(`message_${i}_${makeContent(80)}`);
      }

      const prepared = await history.prepareSpeculativeCompaction({
        phase: "new-turn",
      });
      expect(prepared).not.toBeNull();

      history.setContextLimit(1200);

      // biome-ignore lint/style/noNonNullAssertion: prepared is asserted non-null above
      const result = history.applyPreparedCompaction(prepared!);
      expect(result).toEqual({ applied: false, reason: "stale" });
    });

    it("no speculative job below threshold", () => {
      const history = new MessageHistory({
        compaction: {
          enabled: true,
          maxTokens: 1000,
          reserveTokens: 200,
          speculativeStartRatio: 0.8,
        },
      });
      history.setContextLimit(1000);
      history.addUserMessage("baseline message");
      history.updateActualUsage({ totalTokens: 500 });

      expect(history.shouldStartSpeculativeCompactionForNextTurn()).toBe(false);
    });

    it("full turn cycle with fire-and-forget compaction", async () => {
      const history = new MessageHistory({
        compaction: {
          enabled: true,
          maxTokens: 1200,
          reserveTokens: 200,
          keepRecentTokens: 240,
          summarizeFn: async () => "Turn cycle summary",
        },
      });
      history.setContextLimit(1200);

      for (let i = 0; i < 8; i++) {
        history.addUserMessage(`prefill_${i}_${makeContent(80)}`);
      }
      history.updateActualUsage({ totalTokens: 1100 });

      expect(history.shouldStartSpeculativeCompactionForNextTurn()).toBe(true);

      const preparePromise = history.prepareSpeculativeCompaction({
        phase: "new-turn",
      });

      history.addUserMessage("next_turn_user");
      history.addModelMessages([
        { role: "assistant", content: "next_turn_assistant" },
      ]);

      const prepared = await preparePromise;
      expect(prepared).not.toBeNull();

      // biome-ignore lint/style/noNonNullAssertion: prepared is asserted non-null above
      const result = history.applyPreparedCompaction(prepared!);
      expect(result).toEqual({ applied: true, reason: "applied" });
      expect(history.getSummaries().length).toBeGreaterThanOrEqual(1);

      const llmMessages = history.getMessagesForLLM();
      const contents = llmMessages.flatMap((message) =>
        typeof message.content === "string" ? [message.content] : []
      );
      expect(
        contents.some(
          (content) =>
            content.includes("next_turn_assistant") ||
            content.includes("next_turn_user")
        )
      ).toBe(true);
    });

    it("hard limit blocks, compacts, unblocks", async () => {
      const history = new MessageHistory({
        compaction: {
          enabled: true,
          maxTokens: 600,
          reserveTokens: 100,
          keepRecentTokens: 120,
          summarizeFn: async () => "Hard limit summary",
        },
      });
      history.setContextLimit(600);

      for (let i = 0; i < 6; i++) {
        history.addUserMessage(`hard_${i}_${makeContent(100)}`);
      }
      history.updateActualUsage({ totalTokens: 520 });

      expect(history.isAtHardContextLimit()).toBe(true);

      const prepared = await history.prepareSpeculativeCompaction({
        phase: "new-turn",
      });
      expect(prepared).not.toBeNull();

      // biome-ignore lint/style/noNonNullAssertion: prepared is asserted non-null above
      const result = history.applyPreparedCompaction(prepared!);
      expect(result).toEqual({ applied: true, reason: "applied" });
      expect(history.getSummaries().length).toBeGreaterThanOrEqual(1);
      expect(history.isAtHardContextLimit()).toBe(false);
    });

    it("rapid messages don't trigger redundant speculative jobs", async () => {
      const history = new MessageHistory({
        compaction: {
          enabled: true,
          maxTokens: 1000,
          reserveTokens: 200,
          speculativeStartRatio: 0.7,
          summarizeFn: async () => "Rapid summary",
        },
      });
      history.setContextLimit(1000);

      history.addUserMessage(`seed_${makeContent(80)}`);
      history.updateActualUsage({ totalTokens: 760 });

      let jobRunning = false;
      const maybeStartSpeculativeJob = () => {
        if (
          history.shouldStartSpeculativeCompactionForNextTurn() &&
          !jobRunning
        ) {
          jobRunning = true;
          return history.prepareSpeculativeCompaction({ phase: "new-turn" });
        }
        return null;
      };

      const firstJob = maybeStartSpeculativeJob();
      expect(firstJob).not.toBeNull();

      history.addUserMessage(`rapid_${makeContent(120)}`);

      const secondJob = maybeStartSpeculativeJob();
      expect(secondJob).toBeNull();

      // biome-ignore lint/style/noNonNullAssertion: firstJob is asserted non-null above
      const prepared = await firstJob!;
      expect(prepared).not.toBeNull();
    });
  });

  describe("CJK token estimation", () => {
    it("estimates more tokens for CJK text than Latin text of same length", () => {
      const history = new MessageHistory({ compaction: { enabled: true } });

      // Add CJK text
      history.addUserMessage("안녕하세요 이것은 한국어 테스트입니다");
      const cjkTokens = history.getEstimatedTokens();
      history.clear();

      // Add Latin text of same character count
      const latinText = "x".repeat(
        "안녕하세요 이것은 한국어 테스트입니다".length
      );
      history.addUserMessage(latinText);
      const latinTokens = history.getEstimatedTokens();

      // CJK should estimate more tokens for same char count
      expect(cjkTokens).toBeGreaterThan(latinTokens);
    });
  });
});
