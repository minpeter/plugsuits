import { describe, expect, it, vi } from "vitest";
import {
  applyReadyCompactionCore,
  blockAtHardLimitCore,
  CompactionOrchestrator,
  discardAllJobsCore,
  type SpeculativeCompactionJob,
} from "./compaction-orchestrator";
import { MessageHistory, type PreparedCompaction } from "./message-history";

function createPreparedCompaction(id: string): PreparedCompaction {
  return {
    actualUsage: null,
    baseMessageIds: [],
    baseRevision: 0,
    baseSegmentIds: [],
    compactionMaxTokensAtCreation: 1000,
    contextLimitAtCreation: 1000,
    didChange: true,
    keepRecentTokensAtCreation: 0,
    pendingCompaction: false,
    phase: "new-turn",
    rejected: false,
    segments: [
      {
        createdAt: new Date(),
        endMessageId: "end",
        estimatedTokens: 10,
        id: `segment_summary_${id}`,
        messageCount: 0,
        messageIds: [],
        messages: [],
        startMessageId: id,
        summary: {
          createdAt: new Date(),
          firstKeptMessageId: "end",
          id,
          summary: "summary",
          summaryTokens: 10,
          tokensBefore: 100,
        },
      },
    ],
    tokenDelta: 40,
  };
}

function createJob(
  id: string,
  overrides: Partial<SpeculativeCompactionJob> = {}
): SpeculativeCompactionJob {
  return {
    discarded: false,
    id,
    phase: "new-turn",
    prepared: createPreparedCompaction(id),
    promise: Promise.resolve(),
    state: "completed",
    ...overrides,
  };
}

describe("compaction orchestrator", () => {
  it("does not block when context is below hard limit", async () => {
    let prepareCalls = 0;
    let applyReadyCalls = 0;

    await blockAtHardLimitCore({
      additionalTokens: 50,
      phase: "new-turn",
      isAtHardContextLimit: () => false,
      getLatestRunningSpeculativeCompaction: () => null,
      prepareSpeculativeCompaction: () => {
        prepareCalls += 1;
        return Promise.resolve(null);
      },
      applyPreparedCompaction: () => ({ applied: false, reason: "noop" }),
      applyReadyCompaction: () => {
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

  it("re-fires once when a prepared compaction is stale", () => {
    const jobs = [createJob("stale-1"), createJob("stale-2")];
    let refireCalls = 0;

    const result = applyReadyCompactionCore({
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

    expect(result).toEqual({ applied: false, stale: true });
    expect(refireCalls).toBe(1);
  });

  it("discards all jobs", () => {
    const jobs = [
      createJob("running-1", { prepared: null, state: "running" }),
      createJob("running-2", { prepared: null, state: "running" }),
    ];
    let discardedCount = 0;

    discardAllJobsCore({
      jobs,
      discardJob: (job) => {
        job.discarded = true;
        discardedCount += 1;
      },
    });

    expect(discardedCount).toBe(2);
    expect(jobs.every((job) => job.discarded)).toBe(true);
  });

  it("starts speculative compaction and reports job status", async () => {
    const history = new MessageHistory();
    const prepared = createPreparedCompaction("prepared-1");
    const onJobStatus = vi.fn();
    const orchestrator = new CompactionOrchestrator({ onJobStatus });

    vi.spyOn(
      history,
      "shouldStartSpeculativeCompactionForNextTurn"
    ).mockReturnValue(true);
    vi.spyOn(history, "prepareSpeculativeCompaction").mockResolvedValue(
      prepared
    );
    vi.spyOn(history, "applyPreparedCompaction").mockReturnValue({
      applied: true,
      reason: "applied",
    });

    orchestrator.startSpeculative(history);
    const runningJob = orchestrator.getLatestRunningSpeculativeCompaction();

    expect(runningJob?.id).toBe("background-compaction-1");
    await runningJob?.promise;
    expect(onJobStatus).toHaveBeenNthCalledWith(
      1,
      "background-compaction-1",
      "Compacting...",
      "running"
    );
    expect(onJobStatus).toHaveBeenLastCalledWith(
      "background-compaction-1",
      "",
      "clear"
    );
  });

  it("applies completed jobs and emits applied detail", () => {
    const history = new MessageHistory();
    const onApplied = vi.fn();
    const orchestrator = new CompactionOrchestrator({ onApplied });

    vi.spyOn(history, "applyPreparedCompaction").mockReturnValue({
      applied: true,
      reason: "applied",
    });

    const jobs = orchestrator.getJobs() as SpeculativeCompactionJob[];
    jobs.push(createJob("completed-1"));

    const result = orchestrator.applyReady(history);

    expect(result).toEqual({ applied: true, stale: false });
    expect(onApplied).toHaveBeenCalledWith({
      baseMessageCount: 0,
      newMessageCount: 0,
      phase: "new-turn",
      tokenDelta: 40,
    });
  });
});
