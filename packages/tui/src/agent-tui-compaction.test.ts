import { describe, expect, it } from "bun:test";
import type { PreparedCompaction } from "@ai-sdk-tool/harness";
import {
  applyReadySpeculativeCompactionCore,
  blockAtHardContextLimitCore,
  discardAllSpeculativeCompactionJobsCore,
} from "./agent-tui";

function createPreparedCompaction(id: string): PreparedCompaction {
  return {
    actualUsage: null,
    baseMessageIds: [],
    baseRevision: 0,
    baseSummaryIds: [],
    compactionMaxTokensAtCreation: 1000,
    contextLimitAtCreation: 1000,
    didChange: true,
    keepRecentTokensAtCreation: 0,
    messages: [],
    pendingCompaction: false,
    phase: "new-turn",
    rejected: false,
    summaries: [
      {
        createdAt: new Date(),
        firstKeptMessageId: "end",
        id,
        summary: "summary",
        summaryTokens: 10,
        tokensBefore: 100,
      },
    ],
    tokenDelta: 0,
  };
}

describe("agent-tui compaction core", () => {
  it("does not block when context is below hard limit", async () => {
    let prepareCalls = 0;
    let applyReadyCalls = 0;

    await blockAtHardContextLimitCore({
      additionalTokens: 50,
      phase: "new-turn",
      isAtHardContextLimit: () => false,
      getLatestRunningSpeculativeCompaction: () => null,
      prepareSpeculativeCompaction: () => {
        prepareCalls += 1;
        return Promise.resolve(null);
      },
      applyPreparedCompaction: () => ({ applied: false, reason: "noop" }),
      applyReadySpeculativeCompaction: () => {
        applyReadyCalls += 1;
        return { applied: false, stale: false };
      },
      warnHardLimitStillExceeded: () => {
        throw new Error("should not warn below hard limit");
      },
    });

    expect(prepareCalls).toBe(0);
    expect(applyReadyCalls).toBe(0);
  });

  it("blocks and applies compaction when hard limit is reached", async () => {
    let atHardLimit = true;
    let applyReadyCalls = 0;

    const runningJob = {
      discarded: false,
      id: "running-job",
      phase: "new-turn" as const,
      prepared: createPreparedCompaction("running"),
      state: "running" as const,
      promise: Promise.resolve().then(() => {
        atHardLimit = false;
      }),
    };

    await blockAtHardContextLimitCore({
      additionalTokens: 100,
      phase: "intermediate-step",
      isAtHardContextLimit: () => atHardLimit,
      getLatestRunningSpeculativeCompaction: () => runningJob,
      prepareSpeculativeCompaction: () => {
        throw new Error("should wait existing running job first");
      },
      applyPreparedCompaction: () => ({ applied: true, reason: "applied" }),
      applyReadySpeculativeCompaction: () => {
        applyReadyCalls += 1;
        return { applied: true, stale: false };
      },
      warnHardLimitStillExceeded: () => {
        throw new Error("should not warn after successful blocking compaction");
      },
    });

    expect(applyReadyCalls).toBe(1);
    expect(atHardLimit).toBe(false);
  });

  it("re-fires once when prepared compaction is stale", () => {
    const jobs = [
      {
        discarded: false,
        id: "stale-1",
        phase: "new-turn" as const,
        prepared: createPreparedCompaction("stale-1"),
        promise: Promise.resolve(),
        state: "completed" as const,
      },
      {
        discarded: false,
        id: "stale-2",
        phase: "new-turn" as const,
        prepared: createPreparedCompaction("stale-2"),
        promise: Promise.resolve(),
        state: "completed" as const,
      },
    ];

    let refireCalls = 0;

    const result = applyReadySpeculativeCompactionCore({
      jobs,
      applyPreparedCompaction: () => ({ applied: false, reason: "stale" }),
      discardJob: (job) => {
        job.discarded = true;
      },
      discardAllJobs: () => {
        for (const job of jobs) {
          job.discarded = true;
        }
      },
      onStale: () => {
        refireCalls += 1;
      },
    });

    expect(result.stale).toBe(true);
    expect(result.applied).toBe(false);
    expect(refireCalls).toBe(1);
  });

  it("treats rejected prepared compaction as noop without stale refire", () => {
    const jobs = [
      {
        discarded: false,
        id: "rejected-1",
        phase: "new-turn" as const,
        prepared: createPreparedCompaction("rejected-1"),
        promise: Promise.resolve(),
        state: "completed" as const,
      },
    ];

    let refireCalls = 0;

    const result = applyReadySpeculativeCompactionCore({
      jobs,
      applyPreparedCompaction: () => ({ applied: false, reason: "rejected" }),
      discardJob: (job) => {
        job.discarded = true;
      },
      discardAllJobs: () => {
        throw new Error("should not discard all jobs for rejected result");
      },
      onStale: () => {
        refireCalls += 1;
      },
    });

    expect(result).toEqual({ applied: false, stale: false });
    expect(refireCalls).toBe(0);
    expect(jobs[0]?.discarded).toBe(true);
  });

  it("calls onRejected callback when compaction is rejected", () => {
    const jobs = [
      {
        discarded: false,
        id: "rejected-1",
        phase: "new-turn" as const,
        prepared: createPreparedCompaction("rejected-1"),
        promise: Promise.resolve(),
        state: "completed" as const,
      },
    ];

    let refireCalls = 0;
    let rejectedCalls = 0;

    const result = applyReadySpeculativeCompactionCore({
      jobs,
      applyPreparedCompaction: () => ({ applied: false, reason: "rejected" }),
      discardJob: (job) => {
        job.discarded = true;
      },
      discardAllJobs: () => {
        throw new Error("should not discard all jobs for rejected result");
      },
      onStale: () => {
        refireCalls += 1;
      },
      onRejected: () => {
        rejectedCalls += 1;
      },
    });

    expect(result).toEqual({ applied: false, stale: false });
    expect(refireCalls).toBe(0);
    expect(rejectedCalls).toBe(1);
    expect(jobs[0]?.discarded).toBe(true);
  });

  it("discards all speculative jobs for /clear behavior", () => {
    const jobs = [
      {
        discarded: false,
        id: "running-1",
        phase: "new-turn" as const,
        prepared: null,
        promise: Promise.resolve(),
        state: "running" as const,
      },
      {
        discarded: false,
        id: "running-2",
        phase: "new-turn" as const,
        prepared: null,
        promise: Promise.resolve(),
        state: "running" as const,
      },
    ];

    let discardedCount = 0;
    discardAllSpeculativeCompactionJobsCore({
      jobs,
      discardJob: (job) => {
        job.discarded = true;
        discardedCount += 1;
      },
    });

    expect(discardedCount).toBe(2);
    expect(jobs.every((job) => job.discarded)).toBe(true);
  });
});
