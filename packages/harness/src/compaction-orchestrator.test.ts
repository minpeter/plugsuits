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

    it("still allows manual compaction when DISABLE_AUTO_COMPACT=1", async () => {
      const previousDisableAutoCompact = process.env.DISABLE_AUTO_COMPACT;
      process.env.DISABLE_AUTO_COMPACT = "1";

      try {
        const history = createHistory();
        history.addUserMessage("hello");
        history.addModelMessages([{ role: "assistant", content: "world" }]);

        const compactSpy = vi.spyOn(history, "compact");
        const orchestrator = new CompactionOrchestrator(history);
        const result = await orchestrator.manualCompact();

        expect(result.success).toBe(true);
        expect(compactSpy).toHaveBeenCalledWith({ auto: false });
      } finally {
        if (previousDisableAutoCompact === undefined) {
          Reflect.deleteProperty(process.env, "DISABLE_AUTO_COMPACT");
        } else {
          process.env.DISABLE_AUTO_COMPACT = previousDisableAutoCompact;
        }
      }
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

    it("skips auto compaction when DISABLE_AUTO_COMPACT=1", async () => {
      const previousDisableAutoCompact = process.env.DISABLE_AUTO_COMPACT;
      process.env.DISABLE_AUTO_COMPACT = "1";

      try {
        const history = createHistory({ contextLimit: 80, maxTokens: 10 });
        for (let i = 0; i < 20; i += 1) {
          history.addUserMessage(`message ${i} long enough for threshold`);
        }

        const compactSpy = vi.spyOn(history, "compact");
        const orchestrator = new CompactionOrchestrator(history);
        const didCompact = await orchestrator.checkAndCompact();

        expect(didCompact).toBe(false);
        expect(compactSpy).not.toHaveBeenCalled();
      } finally {
        if (previousDisableAutoCompact === undefined) {
          Reflect.deleteProperty(process.env, "DISABLE_AUTO_COMPACT");
        } else {
          process.env.DISABLE_AUTO_COMPACT = previousDisableAutoCompact;
        }
      }
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
      expect(applied).toEqual({ applied: true, stale: true });
      expect(onComplete).toHaveBeenCalledOnce();
    });

    it("does not start speculative compaction when DISABLE_AUTO_COMPACT=1", () => {
      const previousDisableAutoCompact = process.env.DISABLE_AUTO_COMPACT;
      process.env.DISABLE_AUTO_COMPACT = "1";

      try {
        const history = createHistory({ maxTokens: 10 });
        for (let i = 0; i < 20; i += 1) {
          history.addUserMessage(`long message ${i}`);
        }

        const orchestrator = new CompactionOrchestrator(history);
        expect(orchestrator.shouldStartSpeculative()).toBe(false);
      } finally {
        if (previousDisableAutoCompact === undefined) {
          Reflect.deleteProperty(process.env, "DISABLE_AUTO_COMPACT");
        } else {
          process.env.DISABLE_AUTO_COMPACT = previousDisableAutoCompact;
        }
      }
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

    it("emits onPruneComplete and skips overflow compaction when prune is sufficient", async () => {
      let hardLimited = true;
      const onPruneStart = vi.fn();
      const onPruneComplete = vi.fn();
      const onPruneSkipped = vi.fn();
      const handleContextOverflow = vi.fn().mockResolvedValue({
        success: true,
        strategy: "compact",
        tokensBefore: 120,
        tokensAfter: 40,
      });

      const pruneMessages = vi.fn(() => {
        hardLimited = false;
        return Promise.resolve({
          levelUsed: 2,
          tokensBefore: 240,
          tokensAfter: 60,
        });
      });

      const history = {
        compact: vi.fn(() =>
          Promise.resolve({
            success: true,
            tokensBefore: 0,
            tokensAfter: 0,
          })
        ),
        getCompactionConfig: () => ({
          contextLimit: 120,
          enabled: true,
          reserveTokens: 20,
        }),
        getEstimatedTokens: () => 200,
        handleContextOverflow,
        isAtHardContextLimit: () => hardLimited,
        pruneMessages,
      };

      const orchestrator = new CompactionOrchestrator(history, {
        onPruneComplete,
        onPruneSkipped,
        onPruneStart,
      });

      const blocked = await orchestrator.blockAtHardLimit(20, "new-turn");

      expect(blocked).toBe(true);
      expect(onPruneStart).toHaveBeenCalledOnce();
      expect(onPruneComplete).toHaveBeenCalledWith({
        levelUsed: 2,
        tokensBefore: 240,
        tokensAfter: 60,
      });
      expect(onPruneSkipped).not.toHaveBeenCalled();
      expect(handleContextOverflow).not.toHaveBeenCalled();
    });

    it("emits onPruneSkipped with insufficient when prune cannot meet target", async () => {
      const onPruneSkipped = vi.fn();
      const handleContextOverflow = vi.fn().mockResolvedValue({
        success: true,
        strategy: "compact",
        tokensBefore: 140,
        tokensAfter: 80,
      });

      const history = {
        compact: vi.fn(() =>
          Promise.resolve({
            success: true,
            tokensBefore: 0,
            tokensAfter: 0,
          })
        ),
        getCompactionConfig: () => ({
          contextLimit: 120,
          enabled: true,
          reserveTokens: 20,
        }),
        getEstimatedTokens: () => 200,
        handleContextOverflow,
        isAtHardContextLimit: () => true,
        pruneMessages: vi.fn(() =>
          Promise.resolve({
            levelUsed: 4,
            tokensBefore: 260,
            tokensAfter: 200,
          })
        ),
      };

      const orchestrator = new CompactionOrchestrator(history, {
        onPruneSkipped,
      });

      await orchestrator.blockAtHardLimit(20, "new-turn");

      expect(onPruneSkipped).toHaveBeenCalledWith({ reason: "insufficient" });
      expect(handleContextOverflow).toHaveBeenCalledTimes(1);
    });

    it("fires BlockingCompactionEvent lifecycle: starting → pruning → compacting → completed", async () => {
      const stages: string[] = [];
      const events: {
        blocking: boolean;
        reason: string;
        stage: string;
        tokensBefore?: number;
        tokensAfter?: number;
      }[] = [];
      const history = createHistory({ contextLimit: 40, reserveTokens: 20 });
      history.addUserMessage(
        "this message is definitely long enough to exceed"
      );

      vi.spyOn(history, "handleContextOverflow").mockResolvedValue({
        success: true,
        strategy: "compact",
        tokensBefore: 120,
        tokensAfter: 40,
      });

      const orchestrator = new CompactionOrchestrator(history, {
        onBlockingChange: (event) => {
          stages.push(event.stage);
          events.push({ ...event });
        },
      });

      await orchestrator.blockAtHardLimit(40, "new-turn");

      const [lastStage] = stages.slice(-1);
      const [lastEvent] = events.slice(-1);

      expect(stages[0]).toBe("starting");
      expect(stages[1]).toBe("pruning");
      expect(lastStage).toBe("completed");
      const startEvent = events.find((e) => e.stage === "starting");
      const endEvent = events.find((e) => e.stage === "completed");
      expect(startEvent?.reason).toBe("hard-limit");
      expect(startEvent?.tokensBefore).toBeTypeOf("number");
      expect(endEvent?.reason).toBe("hard-limit");
      expect(endEvent?.tokensAfter).toBeTypeOf("number");
      expect(events[0]?.blocking).toBe(true);
      expect(lastEvent?.blocking).toBe(false);
    });

    it("fires BlockingCompactionEvent with reason 'overflow-recovery' from handleOverflow", async () => {
      const stages: string[] = [];
      const history = createHistory({ contextLimit: 40, reserveTokens: 20 });
      history.addUserMessage("message");

      vi.spyOn(history, "handleContextOverflow").mockResolvedValue({
        success: true,
        strategy: "compact",
        tokensBefore: 120,
        tokensAfter: 40,
      });

      const orchestrator = new CompactionOrchestrator(history, {
        onBlockingChange: (event) => {
          stages.push(event.stage);
        },
      });

      await orchestrator.handleOverflow(new Error("context_length_exceeded"));

      const [lastStage] = stages.slice(-1);

      expect(stages[0]).toBe("starting");
      expect(stages[1]).toBe("compacting");
      expect(lastStage).toBe("completed");
    });

    it("guarantees start/end pairing even when overflow recovery throws", async () => {
      const events: { blocking: boolean; stage: string }[] = [];
      const history = createHistory({ contextLimit: 40, reserveTokens: 20 });
      history.addUserMessage("message");

      vi.spyOn(history, "handleContextOverflow").mockRejectedValue(
        new Error("summarization failed")
      );

      const orchestrator = new CompactionOrchestrator(history, {
        onBlockingChange: (event) => {
          events.push({ blocking: event.blocking, stage: event.stage });
        },
      });

      await orchestrator.handleOverflow(new Error("context_length_exceeded"));

      const startEvents = events.filter((e) => e.blocking);
      const endEvents = events.filter((e) => !e.blocking);
      expect(startEvents.length).toBeGreaterThanOrEqual(1);
      expect(endEvents.length).toBe(1);
      expect(endEvents[0]?.stage).toBe("completed");
    });

    it("emits onPruneSkipped with no-prune-config when prune is unavailable", async () => {
      const onPruneSkipped = vi.fn();
      const handleContextOverflow = vi.fn().mockResolvedValue({
        success: true,
        strategy: "compact",
        tokensBefore: 140,
        tokensAfter: 80,
      });

      const history = {
        compact: vi.fn(() =>
          Promise.resolve({
            success: true,
            tokensBefore: 0,
            tokensAfter: 0,
          })
        ),
        getCompactionConfig: () => ({
          contextLimit: 120,
          enabled: true,
          reserveTokens: 20,
        }),
        getEstimatedTokens: () => 200,
        handleContextOverflow,
        isAtHardContextLimit: () => true,
      };

      const orchestrator = new CompactionOrchestrator(history, {
        onPruneSkipped,
      });

      await orchestrator.blockAtHardLimit(20, "new-turn");

      expect(onPruneSkipped).toHaveBeenCalledWith({
        reason: "no-prune-config",
      });
      expect(handleContextOverflow).toHaveBeenCalledTimes(1);
    });
  });
});
