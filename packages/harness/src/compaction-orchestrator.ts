import {
  estimateTokens,
  type MessageHistory,
  type PreparedCompaction,
} from "./message-history";

export interface SpeculativeCompactionJob {
  discarded: boolean;
  id: string;
  phase: "new-turn";
  prepared: PreparedCompaction | null;
  promise: Promise<void>;
  state: "completed" | "failed" | "running";
}

export type CompactionPhase = "new-turn" | "intermediate-step";

export interface CompactionAppliedDetail {
  baseMessageCount: number;
  jobId?: string;
  newMessageCount: number;
  phase: CompactionPhase;
  tokenDelta: number;
}

export interface CompactionOrchestratorCallbacks {
  onApplied?: (detail: CompactionAppliedDetail) => void;
  onBlockingChange?: (blocking: boolean) => void;
  onError?: (message: string, error: unknown) => void;
  onJobStatus?: (
    id: string,
    message: string,
    state: "clear" | "running"
  ) => void;
  onRejected?: () => void;
  onStillExceeded?: () => void;
}

export function discardAllJobsCore(params: {
  discardJob: (job: SpeculativeCompactionJob) => void;
  jobs: SpeculativeCompactionJob[];
}): void {
  for (const job of [...params.jobs]) {
    params.discardJob(job);
  }
}

export function applyReadyCompactionCore(params: {
  applyPreparedCompaction: (prepared: PreparedCompaction) => {
    applied: boolean;
    reason: "applied" | "noop" | "stale" | "rejected";
  };
  discardAllJobs: () => void;
  discardJob: (job: SpeculativeCompactionJob) => void;
  jobs: SpeculativeCompactionJob[];
  onRejected?: () => void;
  onStale: () => void;
}): { applied: boolean; stale: boolean } {
  let applied = false;
  let stale = false;
  let didRefire = false;

  for (let i = params.jobs.length - 1; i >= 0; i--) {
    const job = params.jobs[i];
    if (!job || job.discarded || job.state !== "completed" || !job.prepared) {
      continue;
    }

    const result = params.applyPreparedCompaction(job.prepared);
    params.discardJob(job);

    if (result.reason === "stale") {
      stale = true;
      if (!didRefire) {
        params.onStale();
        didRefire = true;
      }
      continue;
    }

    if (result.reason === "rejected") {
      params.onRejected?.();
      continue;
    }

    if (result.reason === "applied") {
      params.discardAllJobs();
      applied = true;
    }
    break;
  }

  return { applied, stale };
}

export async function blockAtHardLimitCore(params: {
  additionalTokens: number;
  applyPreparedCompaction: (prepared: PreparedCompaction) => {
    applied: boolean;
    reason: "applied" | "noop" | "stale" | "rejected";
  };
  applyReadyCompaction: () => {
    applied: boolean;
    stale: boolean;
  };
  getLatestRunningSpeculativeCompaction: () => SpeculativeCompactionJob | null;
  isAtHardContextLimit: (
    additionalTokens: number,
    options: { phase: CompactionPhase }
  ) => boolean;
  phase: CompactionPhase;
  prepareSpeculativeCompaction: (
    phase: CompactionPhase
  ) => Promise<PreparedCompaction | null>;
  warnHardLimitStillExceeded: () => void;
}): Promise<void> {
  const isStillHardLimited = (): boolean =>
    params.isAtHardContextLimit(params.additionalTokens, {
      phase: params.phase,
    });

  const retryWithNewTurnPreparation = async (): Promise<void> => {
    const retryPrepared = await params.prepareSpeculativeCompaction("new-turn");
    if (retryPrepared) {
      params.applyPreparedCompaction(retryPrepared);
    }
  };

  const attemptCompaction = async (
    attempt: number
  ): Promise<"continue" | "stop"> => {
    const runningJob = params.getLatestRunningSpeculativeCompaction();
    if (runningJob) {
      await runningJob.promise;
    } else {
      const prepared = await params.prepareSpeculativeCompaction(
        attemptPhases[attempt] ?? "new-turn"
      );
      if (prepared) {
        const result = params.applyPreparedCompaction(prepared);
        if (result.reason === "stale" && attempt === 0) {
          await retryWithNewTurnPreparation();
          return "stop";
        }

        if (result.reason === "rejected") {
          return "stop";
        }
      }
    }

    const readyResult = params.applyReadyCompaction();
    if (readyResult.stale && attempt === 0) {
      return "continue";
    }

    return "continue";
  };

  if (!isStillHardLimited()) {
    return;
  }

  const attemptPhases: CompactionPhase[] = [params.phase, "new-turn"];

  for (let attempt = 0; attempt < attemptPhases.length; attempt += 1) {
    if (!isStillHardLimited()) {
      return;
    }

    if ((await attemptCompaction(attempt)) === "stop") {
      break;
    }
  }

  if (isStillHardLimited()) {
    params.warnHardLimitStillExceeded();
  }
}

export class CompactionOrchestrator {
  private readonly callbacks: CompactionOrchestratorCallbacks;

  private jobCounter = 0;

  private readonly jobs: SpeculativeCompactionJob[] = [];

  constructor(callbacks: CompactionOrchestratorCallbacks = {}) {
    this.callbacks = callbacks;
  }

  getJobs(): readonly SpeculativeCompactionJob[] {
    return this.jobs;
  }

  getLatestRunningSpeculativeCompaction(): SpeculativeCompactionJob | null {
    for (let i = this.jobs.length - 1; i >= 0; i -= 1) {
      const job = this.jobs[i];
      if (job && !job.discarded && job.state === "running") {
        return job;
      }
    }

    return null;
  }

  discardAll(): void {
    discardAllJobsCore({
      jobs: this.jobs,
      discardJob: (job) => {
        this.discardJob(job);
      },
    });
  }

  applyReady(history: MessageHistory): { applied: boolean; stale: boolean } {
    return applyReadyCompactionCore({
      jobs: this.jobs,
      applyPreparedCompaction: (prepared) =>
        this.applyPreparedCompaction(history, prepared),
      discardJob: (job) => {
        this.discardJob(job);
      },
      discardAllJobs: () => {
        this.discardAll();
      },
      onRejected: this.callbacks.onRejected,
      onStale: () => {
        this.startSpeculative(history);
      },
    });
  }

  startSpeculative(history: MessageHistory): void {
    this.applyReady(history);
    if (
      this.jobs.some(
        (job) =>
          !job.discarded &&
          (job.state === "running" || job.state === "completed")
      )
    ) {
      return;
    }

    if (!history.shouldStartSpeculativeCompactionForNextTurn()) {
      return;
    }

    const job: SpeculativeCompactionJob = {
      discarded: false,
      id: `background-compaction-${++this.jobCounter}`,
      phase: "new-turn",
      prepared: null,
      promise: Promise.resolve(),
      state: "running",
    };

    this.callbacks.onJobStatus?.(job.id, "Compacting...", "running");

    job.promise = (async () => {
      try {
        job.prepared = await history.prepareSpeculativeCompaction({
          phase: "new-turn",
        });
        job.state = "completed";

        if (!job.discarded) {
          this.callbacks.onJobStatus?.(job.id, "", "clear");
        }
      } catch (error) {
        job.state = "failed";
        this.callbacks.onJobStatus?.(job.id, "", "clear");
        this.callbacks.onError?.("Speculative compaction failed", error);
      }
    })();

    this.jobs.push(job);
  }

  async blockAtHardLimit(
    history: MessageHistory,
    additionalTokens: number,
    phase: CompactionPhase
  ): Promise<void> {
    const needsBlocking = history.isAtHardContextLimit(additionalTokens, {
      phase,
    });
    if (needsBlocking) {
      this.callbacks.onBlockingChange?.(true);
    }

    await blockAtHardLimitCore({
      additionalTokens,
      phase,
      isAtHardContextLimit: (tokens, options) =>
        history.isAtHardContextLimit(tokens, options),
      getLatestRunningSpeculativeCompaction: () =>
        this.getLatestRunningSpeculativeCompaction(),
      prepareSpeculativeCompaction: (attemptPhase) =>
        history.prepareSpeculativeCompaction({ phase: attemptPhase }),
      applyPreparedCompaction: (prepared) =>
        this.applyPreparedCompaction(history, prepared),
      applyReadyCompaction: () => this.applyReady(history),
      warnHardLimitStillExceeded: () => {
        this.callbacks.onStillExceeded?.();
      },
    });

    if (needsBlocking) {
      this.callbacks.onBlockingChange?.(false);
    }
  }

  async blockIfNeeded(history: MessageHistory, content: string): Promise<void> {
    await this.blockAtHardLimit(history, estimateTokens(content), "new-turn");
  }

  private applyPreparedCompaction(
    history: MessageHistory,
    prepared: PreparedCompaction
  ): {
    applied: boolean;
    reason: "applied" | "noop" | "stale" | "rejected";
  } {
    const result = history.applyPreparedCompaction(prepared);

    if (result.reason === "applied") {
      const newMessageCount = (prepared.segments ?? []).reduce(
        (count, segment) => count + segment.messages.length,
        0
      );
      this.callbacks.onApplied?.({
        baseMessageCount: prepared.baseMessageIds?.length ?? 0,
        newMessageCount,
        phase: prepared.phase ?? "new-turn",
        tokenDelta: prepared.tokenDelta ?? 0,
      });
    } else if (result.reason === "rejected") {
      this.callbacks.onRejected?.();
    }

    return result;
  }

  private discardJob(job: SpeculativeCompactionJob): void {
    job.discarded = true;
    this.callbacks.onJobStatus?.(job.id, "", "clear");
    const index = this.jobs.indexOf(job);
    if (index !== -1) {
      this.jobs.splice(index, 1);
    }
  }
}
