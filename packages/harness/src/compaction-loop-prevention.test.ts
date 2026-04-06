import { describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  COMPACTION_DEBUG: false,
  CONTEXT_LIMIT_OVERRIDE: undefined as number | undefined,
  DISABLE_AUTO_COMPACT: false,
  DEBUG_TOKENS: false,
}));
vi.mock("./env", () => ({ env: mockEnv }));

import { CheckpointHistory } from "./checkpoint-history";
import { CompactionOrchestrator } from "./compaction-orchestrator";
import { INEFFECTIVE_COMPACTION_REASON } from "./compaction-types";

function createHistoryWithFillContent(params: {
  contextLimit: number;
  summarizeFn: () => Promise<string>;
  messageCount?: number;
  messageFiller?: string;
  thresholdRatio?: number;
}): CheckpointHistory {
  const messageCount = params.messageCount ?? 10;
  const messageFiller =
    params.messageFiller ??
    "fill content that goes into the history to push it over the threshold ".repeat(
      5
    );
  const history = new CheckpointHistory({
    compaction: {
      enabled: true,
      contextLimit: params.contextLimit,
      maxTokens: Math.floor(params.contextLimit * 0.5),
      keepRecentTokens: 20,
      reserveTokens: 0,
      thresholdRatio: params.thresholdRatio ?? 0.5,
      summarizeFn: params.summarizeFn,
    },
  });
  for (let i = 0; i < messageCount; i += 1) {
    history.addUserMessage(`${messageFiller} #${i}`);
  }
  return history;
}

describe("compaction acceptance gate (Layer A)", () => {
  it("rejects ineffective compaction that produces verbose summary", async () => {
    const verboseSummaryOf = (_messages: unknown): Promise<string> =>
      Promise.resolve(
        "verbose summary that does not actually reduce token count much ".repeat(
          30
        )
      );

    const history = createHistoryWithFillContent({
      contextLimit: 400,
      summarizeFn: verboseSummaryOf,
      messageCount: 20,
    });

    const result = await history.compact({ auto: true });

    expect(result.success).toBe(false);
    expect(result.reason).toBe(INEFFECTIVE_COMPACTION_REASON);
    expect(result.rejectionReason).toBeDefined();
    expect(result.effectiveness).toBeDefined();
  });

  it("accepts compaction above the trigger threshold as long as it fits the budget", async () => {
    const history = createHistoryWithFillContent({
      contextLimit: 400,
      summarizeFn: async () =>
        "summary that stays above the trigger threshold but still fits within the recovery budget ".repeat(
          5
        ),
      messageCount: 25,
      thresholdRatio: 0.5,
    });

    const result = await history.compact({ auto: true });

    expect(result.success).toBe(true);
    expect(result.effectiveness?.fitsBudget).toBe(true);
  });

  it("accepts compaction with low savings ratio if it clears the trigger threshold", async () => {
    const history = createHistoryWithFillContent({
      contextLimit: 2000,
      summarizeFn: async () =>
        "summary that saves some tokens but is not very aggressive ".repeat(5),
      messageCount: 40,
    });

    const result = await history.compact({ auto: true });

    expect(result.success).toBe(true);
    expect(result.effectiveness?.belowTriggerThreshold).toBe(true);
    expect(result.effectiveness?.fitsBudget).toBe(true);
  });

  it("rolls back messages when compaction is rejected", async () => {
    const history = createHistoryWithFillContent({
      contextLimit: 400,
      summarizeFn: async () =>
        "verbose summary that does not reduce count ".repeat(40),
      messageCount: 20,
    });

    const messagesBefore = history.getActiveMessages().length;
    const summaryBefore = history.getSummaryMessageId();

    await history.compact({ auto: true });

    expect(history.getActiveMessages().length).toBe(messagesBefore);
    expect(history.getSummaryMessageId()).toBe(summaryBefore);
  });

  it("accepts compaction that produces meaningful savings", async () => {
    const history = createHistoryWithFillContent({
      contextLimit: 400,
      summarizeFn: async () => "short",
      messageCount: 25,
    });

    const result = await history.compact({ auto: true });

    expect(result.success).toBe(true);
    expect(result.effectiveness?.fitsBudget).toBe(true);
    expect(result.effectiveness?.belowTriggerThreshold).toBe(true);
    expect(result.effectiveness?.meetsMinSavings).toBe(true);
  });

  it("does not gate manual compaction even when savings are small", async () => {
    const history = createHistoryWithFillContent({
      contextLimit: 400,
      summarizeFn: async () =>
        "verbose summary that does not reduce count ".repeat(40),
      messageCount: 20,
    });

    const result = await history.compact({ auto: false });

    expect(result.success).toBe(true);
  });

  it("skips the gate when pre-compaction tokens are below the trigger", async () => {
    const history = createHistoryWithFillContent({
      contextLimit: 4000,
      summarizeFn: async () => "summary",
      messageCount: 2,
    });

    const result = await history.compact({ auto: true });

    expect(result.success).toBe(true);
  });
});

describe("per-turn compaction cap (Layer E)", () => {
  function createOrchestratorWithHistory(maxPerTurn?: number): {
    history: CheckpointHistory;
    orchestrator: CompactionOrchestrator;
  } {
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 400,
        maxTokens: 200,
        keepRecentTokens: 20,
        reserveTokens: 0,
        thresholdRatio: 0.5,
        summarizeFn: async () => "short",
      },
    });
    const orchestrator = new CompactionOrchestrator(history, {
      maxAcceptedCompactionsPerTurn: maxPerTurn,
    });
    return { history, orchestrator };
  }

  it("defaults to a cap of 10 compactions per turn", () => {
    const { orchestrator } = createOrchestratorWithHistory();
    expect(orchestrator.getMaxAcceptedCompactionsPerTurn()).toBe(10);
  });

  it("honors custom cap value", () => {
    const { orchestrator } = createOrchestratorWithHistory(5);
    expect(orchestrator.getMaxAcceptedCompactionsPerTurn()).toBe(5);
  });

  it("starts each session with zero accepted compactions", () => {
    const { orchestrator } = createOrchestratorWithHistory();
    expect(orchestrator.getAcceptedCompactionsThisTurn()).toBe(0);
    expect(orchestrator.isCompactionCapReached()).toBe(false);
  });

  it("increments counter on successful manual compaction", async () => {
    const { history, orchestrator } = createOrchestratorWithHistory();
    for (let i = 0; i < 25; i += 1) {
      history.addUserMessage(
        `long message that should push tokens above the threshold ${i} `.repeat(
          3
        )
      );
    }

    const result = await orchestrator.manualCompact();
    expect(result.success).toBe(true);
    expect(orchestrator.getAcceptedCompactionsThisTurn()).toBe(1);
  });

  it("skips checkAndCompact when cap is reached", async () => {
    const { history, orchestrator } = createOrchestratorWithHistory(2);
    for (let i = 0; i < 40; i += 1) {
      history.addUserMessage(
        `long message that should push tokens above the threshold ${i} `.repeat(
          4
        )
      );
    }

    await orchestrator.manualCompact();
    expect(orchestrator.getAcceptedCompactionsThisTurn()).toBe(1);
    await orchestrator.manualCompact();
    expect(orchestrator.getAcceptedCompactionsThisTurn()).toBe(2);
    expect(orchestrator.isCompactionCapReached()).toBe(true);

    const didCompact = await orchestrator.checkAndCompact();
    expect(didCompact).toBe(false);
  });

  it("notifyNewUserTurn resets the counter", async () => {
    const { history, orchestrator } = createOrchestratorWithHistory(1);
    for (let i = 0; i < 25; i += 1) {
      history.addUserMessage(
        `long message pushing tokens past threshold ${i} `.repeat(3)
      );
    }

    await orchestrator.manualCompact();
    expect(orchestrator.isCompactionCapReached()).toBe(true);

    orchestrator.notifyNewUserTurn();
    expect(orchestrator.isCompactionCapReached()).toBe(false);
    expect(orchestrator.getAcceptedCompactionsThisTurn()).toBe(0);
  });

  it("shouldStartSpeculative returns false when cap is reached", async () => {
    const { history, orchestrator } = createOrchestratorWithHistory(1);
    for (let i = 0; i < 25; i += 1) {
      history.addUserMessage(
        `long message pushing tokens past threshold ${i} `.repeat(3)
      );
    }

    await orchestrator.manualCompact();
    expect(orchestrator.shouldStartSpeculative()).toBe(false);
  });

  it("does not increment counter on failed compaction", async () => {
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 400,
        maxTokens: 200,
        keepRecentTokens: 20,
        reserveTokens: 0,
        thresholdRatio: 0.5,
        summarizeFn: async () =>
          "verbose summary that does not actually reduce tokens ".repeat(30),
      },
    });
    const orchestrator = new CompactionOrchestrator(history);
    for (let i = 0; i < 25; i += 1) {
      history.addUserMessage(
        `long content that pushes tokens past threshold ${i} `.repeat(3)
      );
    }

    await orchestrator.checkAndCompact();
    expect(orchestrator.getAcceptedCompactionsThisTurn()).toBe(0);
  });

  it("coerces invalid cap values to default", () => {
    const history = new CheckpointHistory({ compaction: { enabled: true } });
    const invalid = new CompactionOrchestrator(history, {
      maxAcceptedCompactionsPerTurn: -5,
    });
    expect(invalid.getMaxAcceptedCompactionsPerTurn()).toBe(10);

    const zero = new CompactionOrchestrator(history, {
      maxAcceptedCompactionsPerTurn: 0,
    });
    expect(zero.getMaxAcceptedCompactionsPerTurn()).toBe(10);

    const nan = new CompactionOrchestrator(history, {
      maxAcceptedCompactionsPerTurn: Number.NaN,
    });
    expect(nan.getMaxAcceptedCompactionsPerTurn()).toBe(10);
  });
});

describe("infinite loop scenario", () => {
  it("stops compacting when gate rejects successive verbose summaries", async () => {
    let callCount = 0;
    const history = createHistoryWithFillContent({
      contextLimit: 400,
      summarizeFn: () => {
        callCount += 1;
        return Promise.resolve(
          "verbose summary that does not reduce tokens meaningfully ".repeat(30)
        );
      },
      messageCount: 25,
    });
    const orchestrator = new CompactionOrchestrator(history);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await orchestrator.checkAndCompact();
      history.addUserMessage(
        `followup message to push tokens back up ${attempt} `.repeat(5)
      );
    }

    expect(callCount).toBeLessThanOrEqual(5);
    expect(history.getEstimatedTokens()).toBeGreaterThan(0);
  });

  it("counts ineffective attempts toward the cap when summary exceeds budget", async () => {
    let callCount = 0;
    const history = createHistoryWithFillContent({
      contextLimit: 300,
      summarizeFn: () => {
        callCount += 1;
        return Promise.resolve("exceeds-budget-summary ".repeat(100));
      },
      messageCount: 25,
    });
    const orchestrator = new CompactionOrchestrator(history, {
      maxAcceptedCompactionsPerTurn: 3,
    });

    await orchestrator.checkAndCompact();
    expect(orchestrator.getIneffectiveAttemptsThisTurn()).toBe(1);
    expect(orchestrator.isCompactionCapReached()).toBe(false);

    await orchestrator.checkAndCompact();
    expect(orchestrator.getIneffectiveAttemptsThisTurn()).toBe(2);
    expect(orchestrator.isCompactionCapReached()).toBe(false);

    await orchestrator.checkAndCompact();
    expect(orchestrator.getIneffectiveAttemptsThisTurn()).toBe(3);
    expect(orchestrator.isCompactionCapReached()).toBe(true);

    await orchestrator.checkAndCompact();
    expect(callCount).toBe(3);
  });

  it("resumes compaction attempts on new user turn after ineffective rejection", async () => {
    let callCount = 0;
    let returnVerbose = true;
    const history = createHistoryWithFillContent({
      contextLimit: 300,
      summarizeFn: () => {
        callCount += 1;
        const summary = returnVerbose
          ? "exceeds-budget-summary ".repeat(100)
          : "short";
        return Promise.resolve(summary);
      },
      messageCount: 25,
    });
    const orchestrator = new CompactionOrchestrator(history, {
      maxAcceptedCompactionsPerTurn: 3,
    });

    await orchestrator.checkAndCompact();
    await orchestrator.checkAndCompact();
    await orchestrator.checkAndCompact();
    expect(orchestrator.isCompactionCapReached()).toBe(true);

    orchestrator.notifyNewUserTurn();
    returnVerbose = false;
    expect(orchestrator.getIneffectiveAttemptsThisTurn()).toBe(0);
    expect(orchestrator.isCompactionCapReached()).toBe(false);

    history.addUserMessage(
      "new user message to keep tokens above trigger ".repeat(10)
    );
    await orchestrator.checkAndCompact();
    expect(callCount).toBe(4);
  });

  it("ineffective speculative compaction counts toward the cap", async () => {
    const history = createHistoryWithFillContent({
      contextLimit: 300,
      summarizeFn: async () => "exceeds-budget-summary ".repeat(100),
      messageCount: 25,
    });
    const orchestrator = new CompactionOrchestrator(history, {
      maxAcceptedCompactionsPerTurn: 3,
    });

    orchestrator.startSpeculative();
    await orchestrator.getLatestRunningSpeculativeCompaction()?.promise;
    const applyResult = orchestrator.applyReady();

    expect(applyResult.applied).toBe(false);
    expect(orchestrator.getIneffectiveAttemptsThisTurn()).toBe(1);
    expect(orchestrator.isCompactionCapReached()).toBe(false);

    const didCompact = await orchestrator.checkAndCompact();
    expect(didCompact).toBe(true);
  });

  it("caps compactions per turn even with aggressive pushes", async () => {
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 400,
        maxTokens: 200,
        keepRecentTokens: 20,
        reserveTokens: 0,
        thresholdRatio: 0.5,
        summarizeFn: async () => "s",
      },
    });
    const orchestrator = new CompactionOrchestrator(history, {
      maxAcceptedCompactionsPerTurn: 2,
    });

    for (let cycle = 0; cycle < 10; cycle += 1) {
      for (let i = 0; i < 30; i += 1) {
        history.addUserMessage(
          `content pushing tokens above threshold cycle=${cycle} i=${i} `.repeat(
            2
          )
        );
      }
      await orchestrator.checkAndCompact();
    }

    expect(orchestrator.getAcceptedCompactionsThisTurn()).toBeLessThanOrEqual(
      2
    );
  });
});
