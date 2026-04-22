import {
  applyReadyCompactionCore,
  blockAtHardLimitCore,
  discardAllJobsCore,
  type PreparedCompaction,
} from "@ai-sdk-tool/harness";
import { describe, expect, it } from "vitest";
import {
  formatCompactionAppliedNotice,
  mergeAgentStreamOptions,
  retryStreamTurnOnContextOverflow,
  retryStreamTurnOnNoOutput,
  shouldDisplayBackgroundCompactionStatus,
  summarizeFooterStatuses,
} from "./agent-tui";

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
    tokenDelta: 0,
  };
}

describe("agent-tui compaction core", () => {
  it("labels background and blocking compaction notices differently", () => {
    expect(
      formatCompactionAppliedNotice({
        detail: "−1200 tokens (now 4.0k)",
        jobId: "background-compaction-1",
      })
    ).toBe("↻ Background compaction applied: −1200 tokens (now 4.0k)");
    expect(
      formatCompactionAppliedNotice({ detail: "−1200 tokens (now 4.0k)" })
    ).toBe("↻ Blocking compaction applied: −1200 tokens (now 4.0k)");
  });

  it("suppresses background compaction status while blocking compaction is active", () => {
    expect(
      shouldDisplayBackgroundCompactionStatus({
        blockingCompactionActive: false,
        state: "running",
      })
    ).toBe(true);
    expect(
      shouldDisplayBackgroundCompactionStatus({
        blockingCompactionActive: true,
        state: "running",
      })
    ).toBe(false);
    expect(
      shouldDisplayBackgroundCompactionStatus({
        blockingCompactionActive: false,
        state: "clear",
      })
    ).toBe(false);
  });

  it("prioritizes blocking compaction over background compaction in the footer", () => {
    expect(
      summarizeFooterStatuses({
        entries: [{ message: "Background compaction...", state: "running" }],
        foregroundMessage: "Compacting...",
      })
    ).toEqual({
      primary: { message: "Compacting", state: "running" },
      secondaryBadge: null,
    });
  });

  it("surfaces background compaction as a lightweight badge beside active work", () => {
    expect(
      summarizeFooterStatuses({
        entries: [{ message: "Background compaction...", state: "running" }],
        foregroundMessage: "Thinking...",
      })
    ).toEqual({
      primary: { message: "Thinking", state: "running" },
      secondaryBadge: "bg compacting",
    });
  });

  it("collapses background-only footer state into a single primary label", () => {
    expect(
      summarizeFooterStatuses({
        entries: [{ message: "Background compaction...", state: "running" }],
        foregroundMessage: null,
      })
    ).toEqual({
      primary: { message: "Bg compacting", state: "running" },
      secondaryBadge: null,
    });
  });

  it("summarizes extra background compaction jobs without adding more footer lines", () => {
    expect(
      summarizeFooterStatuses({
        entries: [
          { message: "Background compaction...", state: "running" },
          { message: "Background compaction...", state: "running" },
          { message: "Background compaction...", state: "running" },
        ],
        foregroundMessage: "Working...",
      })
    ).toEqual({
      primary: { message: "Working", state: "running" },
      secondaryBadge: "bg compacting +2",
    });
  });

  it("runs blocking compaction then retries once on overflow errors", async () => {
    let compactionCalls = 0;
    let retryCalls = 0;

    const result = await retryStreamTurnOnContextOverflow({
      error: new Error("maximum context length exceeded"),
      overflowRetried: false,
      runBlockingCompaction: () => {
        compactionCalls += 1;
        return Promise.resolve(true);
      },
      retry: () => {
        retryCalls += 1;
        return Promise.resolve("completed" as const);
      },
    });

    expect(result).toEqual({ handled: true, result: "completed" });
    expect(compactionCalls).toBe(1);
    expect(retryCalls).toBe(1);
  });

  it("does not retry overflow errors more than once", async () => {
    let compactionCalls = 0;
    let retryCalls = 0;

    const result = await retryStreamTurnOnContextOverflow({
      error: new Error("context_length_exceeded"),
      overflowRetried: true,
      runBlockingCompaction: () => {
        compactionCalls += 1;
        return Promise.resolve(true);
      },
      retry: () => {
        retryCalls += 1;
        return Promise.resolve("completed" as const);
      },
    });

    expect(result).toEqual({ handled: false });
    expect(compactionCalls).toBe(0);
    expect(retryCalls).toBe(0);
  });

  it("retries no-output errors up to the configured retry budget", async () => {
    let retryCalls = 0;

    const result = await retryStreamTurnOnNoOutput({
      error: new Error("No output generated. Check the stream for errors."),
      noOutputRetryCount: 2,
      retry: () => {
        retryCalls += 1;
        return Promise.resolve("completed" as const);
      },
    });

    expect(result).toEqual({ handled: true, result: "completed" });
    expect(retryCalls).toBe(1);
  });

  it("stops retrying no-output errors after three attempts", async () => {
    let retryCalls = 0;

    const result = await retryStreamTurnOnNoOutput({
      error: new Error("No output generated. Check the stream for errors."),
      noOutputRetryCount: 3,
      retry: () => {
        retryCalls += 1;
        return Promise.resolve("completed" as const);
      },
    });

    expect(result).toEqual({ handled: false });
    expect(retryCalls).toBe(0);
  });

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

    await blockAtHardLimitCore({
      additionalTokens: 100,
      phase: "intermediate-step",
      isAtHardContextLimit: () => atHardLimit,
      getLatestRunningSpeculativeCompaction: () => runningJob,
      prepareSpeculativeCompaction: () => {
        throw new Error("should wait existing running job first");
      },
      applyPreparedCompaction: () => ({ applied: true, reason: "applied" }),
      applyReadyCompaction: () => {
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

    const result = applyReadyCompactionCore({
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

    const result = applyReadyCompactionCore({
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

  it("merges full onBeforeTurn stream overrides for TUI turns", () => {
    const tuiAbortController = new AbortController();
    const overrideAbortController = new AbortController();
    const merged = mergeAgentStreamOptions({
      abortSignal: tuiAbortController.signal,
      maxOutputTokens: 128,
      messages: [{ role: "user", content: "base" }],
      turnOverrides: {
        abortSignal: overrideAbortController.signal,
        experimentalContext: { sessionId: "ses_123" },
        maxOutputTokens: 64,
        messages: [{ role: "system", content: "override" }],
        providerOptions: { openai: { parallelToolCalls: false } },
        seed: 7,
        system: "prepared-system",
        temperature: 0,
      },
    });

    expect(merged).toEqual(
      expect.objectContaining({
        experimentalContext: { sessionId: "ses_123" },
        maxOutputTokens: 64,
        messages: [{ role: "system", content: "override" }],
        providerOptions: { openai: { parallelToolCalls: false } },
        seed: 7,
        system: "prepared-system",
        temperature: 0,
      })
    );
    expect(merged.abortSignal).toBeDefined();
    expect(merged.abortSignal).not.toBe(tuiAbortController.signal);
    expect(merged.abortSignal).not.toBe(overrideAbortController.signal);

    overrideAbortController.abort();
    expect(merged.abortSignal?.aborted).toBe(true);
  });

  it("preserves the base abort signal when turn overrides also supply one", () => {
    const tuiAbortController = new AbortController();
    const overrideAbortController = new AbortController();
    const merged = mergeAgentStreamOptions({
      abortSignal: tuiAbortController.signal,
      messages: [{ role: "user", content: "base" }],
      turnOverrides: {
        abortSignal: overrideAbortController.signal,
        messages: [{ role: "system", content: "override" }],
      },
    });

    expect(merged.abortSignal).toBeDefined();
    expect(merged.abortSignal?.aborted).toBe(false);

    tuiAbortController.abort();

    expect(merged.abortSignal?.aborted).toBe(true);
  });
});
