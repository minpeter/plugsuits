import type { OverflowRecoveryResult } from "./checkpoint-history";
import type { CompactionCircuitBreaker } from "./compaction-circuit-breaker";
import {
  computeContextBudget,
  isAtHardContextLimitFromUsage,
  needsCompactionFromUsage,
  shouldStartSpeculativeCompaction,
} from "./compaction-policy";
import type { CompactionResult, PreparedCompaction } from "./compaction-types";
import { env } from "./env";
import { estimateTokens } from "./token-utils";

export interface SpeculativeCompactionJob {
  discarded: boolean;
  id: string;
  phase: "new-turn";
  prepared: PreparedCompaction | null;
  promise: Promise<void>;
  state: "completed" | "failed" | "running";
}

export type CompactionPhase = "new-turn" | "intermediate-step";

export type BlockingCompactionReason =
  | "auto-compact"
  | "hard-limit"
  | "manual"
  | "overflow-recovery";

export type BlockingCompactionStage =
  | "completed"
  | "compacting"
  | "pruning"
  | "starting";

export interface BlockingCompactionEvent {
  blocking: boolean;
  reason: BlockingCompactionReason;
  stage: BlockingCompactionStage;
  tokensAfter?: number;
  tokensBefore?: number;
}

export interface CompactionAppliedDetail {
  baseMessageCount: number;
  jobId?: string;
  newMessageCount: number;
  phase: CompactionPhase;
  tokenDelta: number;
}

export interface CompactionCallbacks {
  onCompactionComplete?: (result: CompactionResult) => void;
  onCompactionError?: (error: unknown) => void;
  onCompactionStart?: () => void;
}

export interface CompactionOrchestratorCallbacks extends CompactionCallbacks {
  onApplied?: (detail: CompactionAppliedDetail) => void;
  onBlockingChange?: (event: BlockingCompactionEvent) => void;
  onError?: (message: string, error: unknown) => void;
  onJobStatus?: (
    id: string,
    message: string,
    state: "clear" | "running"
  ) => void;
  onPruneComplete?: (detail: {
    levelUsed: number;
    tokensAfter: number;
    tokensBefore: number;
  }) => void;
  onPruneSkipped?: (detail: { reason: string }) => void;
  onPruneStart?: () => void;
  onRejected?: () => void;
  onSpeculativeReady?: () => void;
  onStillExceeded?: () => void;
}

export interface CompactionOrchestratorOptions {
  callbacks?: CompactionOrchestratorCallbacks;
  circuitBreaker?: CompactionCircuitBreaker;
}

function isCompactionOrchestratorOptions(
  value: unknown
): value is CompactionOrchestratorOptions {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return "callbacks" in value || "circuitBreaker" in value;
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
  onStale: () => void;
}): { applied: boolean; stale: boolean } {
  let applied = false;
  let stale = false;
  let didRefire = false;

  for (let i = params.jobs.length - 1; i >= 0; i--) {
    const job = params.jobs[i];
    if (job.discarded || job.state !== "completed" || !job.prepared) {
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
  onPruneComplete?: (detail: {
    levelUsed: number;
    tokensAfter: number;
    tokensBefore: number;
  }) => void;
  onPruneSkipped?: (detail: { reason: string }) => void;
  onPruneStart?: () => void;
  prepareSpeculativeCompaction: (
    phase: CompactionPhase
  ) => Promise<PreparedCompaction | null>;
  pruneMessages?: (targetTokens: number) => Promise<{
    levelUsed: number;
    tokensAfter: number;
    tokensBefore: number;
  } | null>;
  targetTokens?: number;
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
        attemptPhases[attempt]
      );
      if (prepared) {
        const result = params.applyPreparedCompaction(prepared);
        if (result.reason === "stale" && attempt === 0) {
          await retryWithNewTurnPreparation();
          return "stop";
        }

        if (result.reason === "rejected") {
          return "continue";
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

  if (
    typeof params.pruneMessages === "function" &&
    typeof params.targetTokens === "number" &&
    Number.isFinite(params.targetTokens)
  ) {
    params.onPruneStart?.();
    const pruneResult = await params.pruneMessages(
      Math.max(0, params.targetTokens)
    );
    if (pruneResult && pruneResult.tokensAfter <= params.targetTokens) {
      params.onPruneComplete?.(pruneResult);
      return;
    }

    params.onPruneSkipped?.({ reason: "insufficient" });
  } else {
    params.onPruneSkipped?.({ reason: "no-prune-config" });
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

interface CompactionHistoryLike {
  compact: (options?: {
    aggressive?: boolean;
    auto?: boolean;
  }) => Promise<CompactionResult | boolean>;
  getCompactionConfig: () => {
    contextLimit?: number;
    enabled?: boolean;
    keepRecentTokens?: number;
    maxTokens?: number;
    reserveTokens?: number;
    speculativeStartRatio?: number;
    thresholdRatio?: number;
  };
  getEstimatedTokens: () => number;
  getMessageRevision?: () => number;
  getRevision?: () => number;
  handleContextOverflow?: (error?: unknown) => Promise<OverflowRecoveryResult>;
  isAtHardContextLimit?: (
    additionalTokens: number,
    options: { phase: CompactionPhase }
  ) => boolean;
  needsCompaction?: () => boolean;
  pruneMessages?: (targetTokens: number) => Promise<{
    levelUsed: number;
    tokensAfter: number;
    tokensBefore: number;
  } | null>;
  shouldStartSpeculativeCompactionForNextTurn?: () => boolean;
}

interface SpeculativeMeta {
  completedMessageRevision: number;
  completedRevision: number;
  error?: unknown;
  result?: CompactionResult;
  startedMessageRevision: number;
  startedRevision: number;
}

const DEFAULT_FAILURE_RESULT: CompactionResult = {
  success: false,
  tokensBefore: 0,
  tokensAfter: 0,
  reason: "unknown compaction error",
};

const BENIGN_COMPACTION_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "compaction disabled",
  "compaction not applied",
  "no messages",
  "no messages to summarize",
  "no summarizeFn",
]);

function isBenignCompactionFailure(result: CompactionResult): boolean {
  if (!result.reason) {
    return false;
  }
  return BENIGN_COMPACTION_FAILURE_REASONS.has(result.reason);
}

function isHistoryLike(value: unknown): value is CompactionHistoryLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.compact === "function" &&
    typeof candidate.getCompactionConfig === "function" &&
    typeof candidate.getEstimatedTokens === "function"
  );
}

function toCompactionResult(
  result: CompactionResult | boolean
): CompactionResult {
  if (typeof result === "boolean") {
    return {
      success: result,
      tokensBefore: 0,
      tokensAfter: 0,
      reason: result ? undefined : "compaction not applied",
    };
  }

  return result;
}

export class CompactionOrchestrator {
  private readonly callbacks: CompactionOrchestratorCallbacks;
  private readonly circuitBreaker: CompactionCircuitBreaker | undefined;
  private readonly history: CompactionHistoryLike | null;
  private compactionInProgress = false;
  private jobCounter = 0;
  private readonly jobs: SpeculativeCompactionJob[] = [];
  private readonly speculativeMeta = new Map<string, SpeculativeMeta>();

  constructor(
    history: CompactionHistoryLike,
    callbacksOrOptions?:
      | CompactionOrchestratorCallbacks
      | CompactionOrchestratorOptions
  );
  constructor(
    callbacksOrOptions?:
      | CompactionOrchestratorCallbacks
      | CompactionOrchestratorOptions
  );
  constructor(
    historyOrCallbacks?:
      | CompactionHistoryLike
      | CompactionOrchestratorCallbacks
      | CompactionOrchestratorOptions,
    maybeCallbacks?:
      | CompactionOrchestratorCallbacks
      | CompactionOrchestratorOptions
  ) {
    const resolveCallbacks = (
      value?: CompactionOrchestratorCallbacks | CompactionOrchestratorOptions
    ): CompactionOrchestratorCallbacks => {
      if (!value) {
        return {};
      }

      if (isCompactionOrchestratorOptions(value)) {
        return value.callbacks ?? {};
      }

      return value;
    };

    const resolveCircuitBreaker = (
      value?: CompactionOrchestratorCallbacks | CompactionOrchestratorOptions
    ): CompactionCircuitBreaker | undefined => {
      if (!(value && isCompactionOrchestratorOptions(value))) {
        return undefined;
      }

      return value.circuitBreaker;
    };

    if (isHistoryLike(historyOrCallbacks)) {
      this.history = historyOrCallbacks;
      this.callbacks = resolveCallbacks(maybeCallbacks);
      this.circuitBreaker = resolveCircuitBreaker(maybeCallbacks);
      return;
    }

    this.history = null;
    this.callbacks = resolveCallbacks(historyOrCallbacks);
    this.circuitBreaker = resolveCircuitBreaker(historyOrCallbacks);
  }

  private debugLog(message: string): void {
    if (env.COMPACTION_DEBUG) {
      console.error(`[compaction-debug] ${message}`);
    }
  }

  getJobs(): readonly SpeculativeCompactionJob[] {
    return this.jobs;
  }

  getLatestRunningSpeculativeCompaction(): SpeculativeCompactionJob | null {
    for (let index = this.jobs.length - 1; index >= 0; index -= 1) {
      const job = this.jobs[index];
      if (!job.discarded && job.state === "running") {
        return job;
      }
    }

    return null;
  }

  isRunning(): boolean {
    return this.compactionInProgress;
  }

  discardAll(): void {
    discardAllJobsCore({
      jobs: this.jobs,
      discardJob: (job) => {
        this.discardJob(job);
      },
    });
  }

  manualCompact(): Promise<CompactionResult> {
    const history = this.requireHistory();

    if (this.compactionInProgress) {
      return Promise.resolve({
        ...DEFAULT_FAILURE_RESULT,
        reason: "compaction in progress",
      });
    }

    return this.runCompaction(history, { auto: false });
  }

  async checkAndCompact(): Promise<boolean> {
    if (env.DISABLE_AUTO_COMPACT) {
      return false;
    }

    const history = this.requireHistory();

    if (this.circuitBreaker?.isOpen()) {
      this.debugLog("checkAndCompact skip: circuit breaker open");
      return false;
    }

    if (this.compactionInProgress || !this.needsCompaction(history)) {
      this.debugLog(
        `checkAndCompact skip: inProgress=${this.compactionInProgress}, needs=${this.needsCompaction(history)}`
      );
      return false;
    }

    this.debugLog("checkAndCompact → blocking compaction");
    await this.runCompaction(history, { auto: true });
    return true;
  }

  async handleOverflow(error?: unknown): Promise<OverflowRecoveryResult> {
    const history = this.requireHistory();
    const tokensBefore = history.getEstimatedTokens();

    this.callbacks.onBlockingChange?.({
      blocking: true,
      reason: "overflow-recovery",
      stage: "starting",
      tokensBefore,
    });

    try {
      this.callbacks.onBlockingChange?.({
        blocking: true,
        reason: "overflow-recovery",
        stage: "compacting",
        tokensBefore,
      });
      return await this.handleOverflowInternal(error);
    } finally {
      this.callbacks.onBlockingChange?.({
        blocking: false,
        reason: "overflow-recovery",
        stage: "completed",
        tokensBefore,
        tokensAfter: history.getEstimatedTokens(),
      });
    }
  }

  private async handleOverflowInternal(
    error?: unknown
  ): Promise<OverflowRecoveryResult> {
    const history = this.requireHistory();

    if (!history.handleContextOverflow) {
      const fallback = await this.runCompaction(history, {
        auto: true,
        aggressive: true,
        suppressBlockingEvents: true,
      });
      return {
        success: fallback.success,
        tokensBefore: fallback.tokensBefore,
        tokensAfter: fallback.tokensAfter,
        error: fallback.success ? undefined : fallback.reason,
        strategy: fallback.success ? "aggressive-compact" : undefined,
      };
    }

    this.callbacks.onCompactionStart?.();
    try {
      return await history.handleContextOverflow(error);
    } catch (overflowError) {
      this.reportError("Overflow recovery failed", overflowError);
      return {
        success: false,
        tokensBefore: history.getEstimatedTokens(),
        tokensAfter: history.getEstimatedTokens(),
        error:
          overflowError instanceof Error
            ? overflowError.message
            : String(overflowError),
      };
    }
  }

  shouldStartSpeculative(history?: CompactionHistoryLike): boolean {
    if (env.DISABLE_AUTO_COMPACT) {
      return false;
    }

    const resolvedHistory = this.resolveHistory(history);
    if (!resolvedHistory || this.compactionInProgress) {
      this.debugLog(
        `shouldStartSpeculative=false: noHistory=${!resolvedHistory}, inProgress=${this.compactionInProgress}`
      );
      return false;
    }

    if (this.jobs.some((job) => !job.discarded && job.state !== "failed")) {
      this.debugLog("shouldStartSpeculative=false: existingJob");
      return false;
    }

    if (
      typeof resolvedHistory.shouldStartSpeculativeCompactionForNextTurn ===
      "function"
    ) {
      const result =
        resolvedHistory.shouldStartSpeculativeCompactionForNextTurn();
      this.debugLog(`shouldStartSpeculative=${result} (via history)`);
      return result;
    }

    if (this.needsCompaction(resolvedHistory)) {
      return true;
    }

    const config = resolvedHistory.getCompactionConfig();
    const estimatedTokens = resolvedHistory.getEstimatedTokens();
    const reserveTokens = Math.max(0, config.reserveTokens ?? 0);
    const contextLimit = this.resolvePolicyContextLimit(config);

    return shouldStartSpeculativeCompaction({
      contextLimit,
      input: {
        enabled: config.enabled ?? false,
        hasMessages: estimatedTokens > 0,
        currentUsageTokens: estimatedTokens,
        phaseReserveTokens: reserveTokens,
        speculativeStartRatio: config.speculativeStartRatio,
      },
    });
  }

  startSpeculative(history?: CompactionHistoryLike): void {
    const resolvedHistory = this.resolveHistory(history);
    if (!resolvedHistory) {
      return;
    }

    if (!this.shouldStartSpeculative(history)) {
      return;
    }

    const jobId = `background-compaction-${++this.jobCounter}`;
    const startedRevision = this.getRevision(resolvedHistory);
    const startedMessageRevision = this.getMessageRevision(resolvedHistory);
    this.compactionInProgress = true;

    const job: SpeculativeCompactionJob = {
      discarded: false,
      id: jobId,
      phase: "new-turn",
      prepared: null,
      promise: Promise.resolve(),
      state: "running",
    };

    this.callbacks.onJobStatus?.(jobId, "Background compaction...", "running");

    job.promise = (async () => {
      try {
        const result = await resolvedHistory.compact({ auto: true });
        this.speculativeMeta.set(job.id, {
          startedRevision,
          startedMessageRevision,
          completedRevision: this.getRevision(resolvedHistory),
          completedMessageRevision: this.getMessageRevision(resolvedHistory),
          result: toCompactionResult(result),
        });
        job.state = "completed";
      } catch (error) {
        this.speculativeMeta.set(job.id, {
          startedRevision,
          startedMessageRevision,
          completedRevision: this.getRevision(resolvedHistory),
          completedMessageRevision: this.getMessageRevision(resolvedHistory),
          error,
        });
        job.state = "failed";
      } finally {
        this.compactionInProgress = false;
        if (!job.discarded) {
          this.callbacks.onJobStatus?.(jobId, "", "clear");
          if (job.state === "completed") {
            this.callbacks.onSpeculativeReady?.();
          }
        }
      }
    })();

    this.jobs.push(job);
  }

  applyReady(history?: CompactionHistoryLike): {
    applied: boolean;
    stale: boolean;
  } {
    const resolvedHistory = this.resolveHistory(history);
    if (!resolvedHistory) {
      return { applied: false, stale: false };
    }

    for (let index = this.jobs.length - 1; index >= 0; index -= 1) {
      const job = this.jobs[index];
      if (job.discarded || job.state === "running") {
        continue;
      }

      const meta = this.speculativeMeta.get(job.id);
      this.discardJob(job);

      if (!meta) {
        continue;
      }

      if (meta.error) {
        this.reportError("Speculative compaction failed", meta.error);
        continue;
      }

      if (!meta.result) {
        continue;
      }

      const stale = this.isStaleSpeculativeResult(resolvedHistory, meta);

      this.emitCompactionResult(meta.result, {
        jobId: job.id,
        phase: "new-turn",
      });
      return { applied: meta.result.success, stale };
    }

    return { applied: false, stale: false };
  }

  async blockAtHardLimit(
    history: CompactionHistoryLike,
    additionalTokens: number,
    phase: CompactionPhase
  ): Promise<boolean>;
  async blockAtHardLimit(
    additionalTokens: number,
    phase: CompactionPhase
  ): Promise<boolean>;
  async blockAtHardLimit(
    historyOrAdditionalTokens: CompactionHistoryLike | number,
    additionalTokensOrPhase: number | CompactionPhase,
    maybePhase?: CompactionPhase
  ): Promise<boolean> {
    const hasHistoryArg = isHistoryLike(historyOrAdditionalTokens);
    const history = this.resolveHistory(
      hasHistoryArg ? historyOrAdditionalTokens : undefined
    );
    if (!history) {
      return Promise.resolve(false);
    }

    const additionalTokens = hasHistoryArg
      ? (additionalTokensOrPhase as number)
      : (historyOrAdditionalTokens as number);
    const phase = (
      hasHistoryArg ? maybePhase : additionalTokensOrPhase
    ) as CompactionPhase;

    let blocking = this.isAtHardLimit(history, additionalTokens, phase);
    if (!blocking) {
      return false;
    }

    if (this.compactionInProgress) {
      const runningJob = this.getLatestRunningSpeculativeCompaction();
      if (runningJob) {
        this.debugLog(
          "blockAtHardLimit → awaiting in-flight speculative before emergency"
        );
        await runningJob.promise;
        blocking = this.isAtHardLimit(history, additionalTokens, phase);
        if (!blocking) {
          return true;
        }
      }
    }

    const tokensBefore = history.getEstimatedTokens();
    this.callbacks.onBlockingChange?.({
      blocking: true,
      reason: "hard-limit",
      stage: "starting",
      tokensBefore,
    });
    try {
      this.callbacks.onBlockingChange?.({
        blocking: true,
        reason: "hard-limit",
        stage: "pruning",
        tokensBefore,
      });
      const pruneHandled = await this.tryPruneBeforeOverflow(
        history,
        additionalTokens,
        phase
      );

      if (!pruneHandled) {
        this.callbacks.onBlockingChange?.({
          blocking: true,
          reason: "hard-limit",
          stage: "compacting",
          tokensBefore,
        });
        await this.handleOverflowInternal(
          new Error("context_limit_hard_block")
        );
      }
    } finally {
      this.callbacks.onBlockingChange?.({
        blocking: false,
        reason: "hard-limit",
        stage: "completed",
        tokensBefore,
        tokensAfter: history.getEstimatedTokens(),
      });
    }

    if (this.isAtHardLimit(history, additionalTokens, phase)) {
      this.callbacks.onStillExceeded?.();
    }

    return true;
  }

  blockIfNeeded(
    history: CompactionHistoryLike,
    content: string
  ): Promise<boolean>;
  blockIfNeeded(content: string): Promise<boolean>;
  blockIfNeeded(
    historyOrContent: CompactionHistoryLike | string,
    maybeContent?: string
  ): Promise<boolean> {
    const content =
      typeof historyOrContent === "string" ? historyOrContent : maybeContent;
    if (!content) {
      return Promise.resolve(false);
    }

    if (isHistoryLike(historyOrContent)) {
      return this.blockAtHardLimit(
        historyOrContent,
        estimateTokens(content),
        "new-turn"
      );
    }

    return this.blockAtHardLimit(estimateTokens(content), "new-turn");
  }

  private resolveHistory(explicit?: unknown): CompactionHistoryLike | null {
    if (explicit && isHistoryLike(explicit)) {
      return explicit as CompactionHistoryLike;
    }

    return this.history;
  }

  private requireHistory(): CompactionHistoryLike {
    if (!this.history) {
      throw new Error(
        "CompactionOrchestrator requires CheckpointHistory in constructor"
      );
    }

    return this.history;
  }

  private getRevision(history: CompactionHistoryLike): number {
    return history.getRevision?.() ?? 0;
  }

  private getMessageRevision(history: CompactionHistoryLike): number {
    if (typeof history.getMessageRevision === "function") {
      return history.getMessageRevision();
    }
    return this.getRevision(history);
  }

  private resolvePolicyContextLimit(
    config: ReturnType<CompactionHistoryLike["getCompactionConfig"]>
  ): number {
    const rawContextLimit =
      (config.contextLimit ?? 0) > 0
        ? (config.contextLimit ?? 0)
        : Math.max(1, config.maxTokens ?? 0, (config.reserveTokens ?? 0) * 3);

    const budget = computeContextBudget({
      contextLimit: rawContextLimit,
      maxOutputTokens: config.maxTokens,
      reserveTokens: config.reserveTokens,
      thresholdRatio: config.thresholdRatio,
    });

    return Math.max(1, budget.effectiveContextWindow);
  }

  private needsCompaction(history: CompactionHistoryLike): boolean {
    if (typeof history.needsCompaction === "function") {
      return history.needsCompaction();
    }

    const config = history.getCompactionConfig();
    const contextLimit = this.resolvePolicyContextLimit(config);
    const configuredThresholdRatio = config.thresholdRatio ?? 0.5;
    const maxTokensRatio =
      typeof config.maxTokens === "number" &&
      Number.isFinite(config.maxTokens) &&
      config.maxTokens > 0 &&
      contextLimit > 0
        ? config.maxTokens / contextLimit
        : undefined;
    const thresholdRatio =
      typeof maxTokensRatio === "number"
        ? Math.min(configuredThresholdRatio, maxTokensRatio)
        : configuredThresholdRatio;

    return needsCompactionFromUsage({
      enabled: config.enabled ?? false,
      hasMessages: history.getEstimatedTokens() > 0,
      currentUsageTokens: history.getEstimatedTokens(),
      contextLimit,
      thresholdRatio,
    });
  }

  private isAtHardLimit(
    history: CompactionHistoryLike,
    additionalTokens: number,
    phase: CompactionPhase
  ): boolean {
    if (typeof history.isAtHardContextLimit === "function") {
      return history.isAtHardContextLimit(additionalTokens, { phase });
    }

    const config = history.getCompactionConfig();
    const contextLimit = config.contextLimit ?? 0;
    if (contextLimit <= 0) {
      return false;
    }

    const phaseMultiplier = phase === "intermediate-step" ? 2 : 1;
    const reserveTokens = Math.max(
      0,
      (config.reserveTokens ?? 0) * phaseMultiplier
    );
    return isAtHardContextLimitFromUsage({
      contextLimit,
      currentUsageTokens: history.getEstimatedTokens(),
      enabled: config.enabled ?? false,
      reserveTokens,
      additionalTokens,
    });
  }

  private isStaleSpeculativeResult(
    history: CompactionHistoryLike,
    meta: SpeculativeMeta
  ): boolean {
    if (!meta.result?.success) {
      return false;
    }

    const currentMessageRevision = this.getMessageRevision(history);

    if (currentMessageRevision > meta.completedMessageRevision) {
      return true;
    }

    const midFlightMessageChange =
      meta.completedMessageRevision !== meta.startedMessageRevision + 1;
    return midFlightMessageChange;
  }

  private resolvePruneTargetTokens(
    history: CompactionHistoryLike,
    additionalTokens: number,
    phase: CompactionPhase
  ): number | null {
    const config = history.getCompactionConfig();
    const contextLimit = config.contextLimit ?? 0;
    if (contextLimit <= 0) {
      return null;
    }

    const phaseMultiplier = phase === "intermediate-step" ? 2 : 1;
    const reserveTokens = Math.max(
      0,
      (config.reserveTokens ?? 0) * phaseMultiplier
    );

    return Math.max(
      0,
      contextLimit - reserveTokens - Math.max(0, additionalTokens)
    );
  }

  private async tryPruneBeforeOverflow(
    history: CompactionHistoryLike,
    additionalTokens: number,
    phase: CompactionPhase
  ): Promise<boolean> {
    const pruneTargetTokens = this.resolvePruneTargetTokens(
      history,
      additionalTokens,
      phase
    );
    if (
      typeof history.pruneMessages !== "function" ||
      pruneTargetTokens === null
    ) {
      this.callbacks.onPruneSkipped?.({ reason: "no-prune-config" });
      return false;
    }

    this.callbacks.onPruneStart?.();
    const pruneResult = await history.pruneMessages(pruneTargetTokens);
    if (pruneResult && pruneResult.tokensAfter <= pruneTargetTokens) {
      this.callbacks.onPruneComplete?.(pruneResult);
      return true;
    }

    this.callbacks.onPruneSkipped?.({ reason: "insufficient" });
    return false;
  }

  private async runCompaction(
    history: CompactionHistoryLike,
    options: {
      aggressive?: boolean;
      auto: boolean;
      suppressBlockingEvents?: boolean;
    }
  ): Promise<CompactionResult> {
    this.compactionInProgress = true;
    this.callbacks.onCompactionStart?.();

    const emitBlocking = !options.suppressBlockingEvents;
    const reason: BlockingCompactionReason = options.auto
      ? "auto-compact"
      : "manual";
    const tokensBefore = history.getEstimatedTokens();
    if (emitBlocking) {
      this.callbacks.onBlockingChange?.({
        blocking: true,
        reason,
        stage: "compacting",
        tokensBefore,
      });
    }

    try {
      const result = toCompactionResult(await history.compact(options));
      if (result.success) {
        this.circuitBreaker?.recordSuccess();
      } else if (!isBenignCompactionFailure(result)) {
        this.circuitBreaker?.recordFailure(
          result.reason ?? "compaction returned success: false"
        );
      }
      this.emitCompactionResult(result, { phase: "new-turn" });
      return result;
    } catch (error) {
      this.circuitBreaker?.recordFailure(
        error instanceof Error ? error.message : String(error)
      );
      this.reportError("Compaction failed", error);
      return {
        ...DEFAULT_FAILURE_RESULT,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.compactionInProgress = false;
      if (emitBlocking) {
        this.callbacks.onBlockingChange?.({
          blocking: false,
          reason,
          stage: "completed",
          tokensBefore,
          tokensAfter: history.getEstimatedTokens(),
        });
      }
    }
  }

  getState(): {
    circuitBreakerOpen: boolean;
    compactionInProgress: boolean;
    jobs: number;
  } {
    return {
      circuitBreakerOpen: this.circuitBreaker?.isOpen() ?? false,
      compactionInProgress: this.compactionInProgress,
      jobs: this.jobs.filter((job) => !job.discarded).length,
    };
  }

  private emitCompactionResult(
    result: CompactionResult,
    detail: Pick<CompactionAppliedDetail, "jobId" | "phase">
  ): void {
    this.callbacks.onCompactionComplete?.(result);

    if (result.success) {
      this.callbacks.onApplied?.({
        baseMessageCount: 0,
        newMessageCount: 0,
        phase: detail.phase,
        jobId: detail.jobId,
        tokenDelta: result.tokensAfter - result.tokensBefore,
      });
      return;
    }

    this.callbacks.onRejected?.();
  }

  private reportError(message: string, error: unknown): void {
    this.callbacks.onCompactionError?.(error);
    this.callbacks.onError?.(message, error);
  }

  private discardJob(job: SpeculativeCompactionJob): void {
    job.discarded = true;
    this.callbacks.onJobStatus?.(job.id, "", "clear");
    this.speculativeMeta.delete(job.id);
    const index = this.jobs.indexOf(job);
    if (index !== -1) {
      this.jobs.splice(index, 1);
    }
  }
}
