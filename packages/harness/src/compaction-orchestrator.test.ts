import { describe, expect, it, vi } from "vitest";
import { CheckpointHistory } from "./checkpoint-history";
import { CompactionOrchestrator } from "./compaction-orchestrator";

function createHistory(
  options?: Partial<ReturnType<CheckpointHistory["getCompactionConfig"]>>
): CheckpointHistory {
  return new CheckpointHistory({
    compaction: {
      enabled: true,
      contextLimit: 512,
      maxTokens: 120,
      keepRecentTokens: 40,
      reserveTokens: 32,
      summarizeFn: async () => "Summary",
      ...options,
    },
  });
}

describe("CompactionOrchestrator", () => {
  describe("manualCompact()", () => {
    it("calls compact with auto=false and returns result", async () => {
      const history = createHistory();
      history.addUserMessage("hello");
      history.addModelMessages([{ role: "assistant", content: "world" }]);

      const compactSpy = vi.spyOn(history, "compact");
      const orchestrator = new CompactionOrchestrator(history);
      const result = await orchestrator.manualCompact();

      expect(compactSpy).toHaveBeenCalledWith({ auto: false });
      expect(result.success).toBe(true);
      expect(history.getSummaryMessageId()).not.toBeNull();
    });

    it("fires start/complete callbacks", async () => {
      const history = createHistory();
      history.addUserMessage("hello");
      history.addModelMessages([{ role: "assistant", content: "world" }]);

      const onStart = vi.fn();
      const onComplete = vi.fn();
      const orchestrator = new CompactionOrchestrator(history, {
        onCompactionComplete: onComplete,
        onCompactionStart: onStart,
      });

      await orchestrator.manualCompact();

      expect(onStart).toHaveBeenCalledOnce();
      expect(onComplete).toHaveBeenCalledOnce();
    });

    it("returns failure when another compaction is already running", async () => {
      let resolveSummary: ((summary: string) => void) | undefined;
      const history = createHistory({
        summarizeFn: () =>
          new Promise<string>((resolve) => {
            resolveSummary = resolve;
          }),
      });
      history.addUserMessage("hello");
      history.addModelMessages([{ role: "assistant", content: "world" }]);

      const orchestrator = new CompactionOrchestrator(history);
      const first = orchestrator.manualCompact();
      const second = await orchestrator.manualCompact();

      expect(second.success).toBe(false);
      expect(second.reason).toContain("in progress");

      resolveSummary?.("Summary");
      await first;
    });
  });

  describe("checkAndCompact()", () => {
    it("runs auto compaction when usage exceeds threshold", async () => {
      const history = createHistory({ contextLimit: 80, maxTokens: 10 });
      for (let i = 0; i < 20; i += 1) {
        history.addUserMessage(`message ${i} long enough for threshold`);
      }

      const compactSpy = vi.spyOn(history, "compact");
      const orchestrator = new CompactionOrchestrator(history);
      await orchestrator.checkAndCompact();

      expect(compactSpy).toHaveBeenCalledWith({ auto: true });
    });

    it("does not compact when usage is below threshold", async () => {
      const history = createHistory({ maxTokens: 999_999 });
      history.addUserMessage("small");
      const compactSpy = vi.spyOn(history, "compact");

      const orchestrator = new CompactionOrchestrator(history);
      await orchestrator.checkAndCompact();

      expect(compactSpy).not.toHaveBeenCalled();
    });
  });

  describe("handleOverflow()", () => {
    it("delegates to history.handleContextOverflow()", async () => {
      const history = createHistory();
      const spy = vi.spyOn(history, "handleContextOverflow").mockResolvedValue({
        success: true,
        strategy: "compact",
        tokensBefore: 200,
        tokensAfter: 80,
      });

      const orchestrator = new CompactionOrchestrator(history);
      const result = await orchestrator.handleOverflow(
        new Error("context_length_exceeded")
      );

      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.tokensAfter).toBe(80);
    });
  });

  describe("speculative lifecycle", () => {
    it("applyReady() applies completed speculative compaction", async () => {
      const history = createHistory({ maxTokens: 10 });
      for (let i = 0; i < 20; i += 1) {
        history.addUserMessage(`long message ${i}`);
      }

      const onComplete = vi.fn();
      const orchestrator = new CompactionOrchestrator(history, {
        onCompactionComplete: onComplete,
      });

      expect(orchestrator.shouldStartSpeculative()).toBe(true);
      orchestrator.startSpeculative();
      await orchestrator.getLatestRunningSpeculativeCompaction()?.promise;

      const applied = orchestrator.applyReady();
      expect(applied).toEqual({ applied: true, stale: false });
      expect(onComplete).toHaveBeenCalledOnce();
    });

    it("rejects stale speculative result when history revision changed", async () => {
      let resolveSummary: ((summary: string) => void) | undefined;
      const history = createHistory({
        contextLimit: 80,
        maxTokens: 10,
        summarizeFn: () =>
          new Promise<string>((resolve) => {
            resolveSummary = resolve;
          }),
      });
      for (let i = 0; i < 12; i += 1) {
        history.addUserMessage(`long message ${i}`);
      }

      const onComplete = vi.fn();
      const orchestrator = new CompactionOrchestrator(history, {
        onCompactionComplete: onComplete,
      });

      orchestrator.startSpeculative();
      history.addUserMessage("mutation while speculative runs");
      resolveSummary?.("Summary");
      await orchestrator.getLatestRunningSpeculativeCompaction()?.promise;

      const applied = orchestrator.applyReady();
      expect(applied).toEqual({ applied: false, stale: true });
      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  describe("blockAtHardLimit()", () => {
    it("returns false when not at hard limit", async () => {
      const history = createHistory({
        contextLimit: 10_000,
        reserveTokens: 32,
      });
      history.addUserMessage("short");
      const orchestrator = new CompactionOrchestrator(history);

      const blocked = await orchestrator.blockAtHardLimit(0, "new-turn");
      expect(blocked).toBe(false);
    });

    it("returns true and recovers when hard limit is exceeded", async () => {
      const history = createHistory({ contextLimit: 40, reserveTokens: 20 });
      history.addUserMessage(
        "this message is definitely long enough to exceed"
      );

      const overflowSpy = vi
        .spyOn(history, "handleContextOverflow")
        .mockResolvedValue({
          success: true,
          strategy: "compact",
          tokensBefore: 120,
          tokensAfter: 40,
        });

      const orchestrator = new CompactionOrchestrator(history);
      const blocked = await orchestrator.blockAtHardLimit(40, "new-turn");

      expect(blocked).toBe(true);
      expect(overflowSpy).toHaveBeenCalledTimes(1);
    });
  });
});
