/**
 * ATIF-v1.4 trajectory collector.
 *
 * This module is the ONLY surface in the headless package that produces the
 * persisted `trajectory.json` file, and that file MUST conform to Harbor's
 * ATIF v1.4 specification:
 *
 *   https://www.harborframework.com/docs/agents/trajectory-format
 *
 * ATIF v1.4 compliance rules (load-bearing — do not relax without bumping
 * the Harbor spec version this package claims to target):
 *
 *   • `schema_version` is the literal string "ATIF-v1.4".
 *   • Every {@link AtifStep.step_id} is a sequential integer starting at 1.
 *   • `steps[*].source` is limited to `"user" | "agent" | "system"`; no
 *     lifecycle event type is ever persisted as a step source.
 *   • Persisted lifecycle annotations go under `extra.approval_events`,
 *     `extra.compaction_events`, and `extra.interrupt_events`. New
 *     lifecycle types must NOT introduce new top-level fields; pick an
 *     existing `extra.*` bucket or drop the event from persistence.
 *   • Transient lifecycle events (`turn-start`, `error`) are JSONL-only
 *     and are dropped by the collector.
 *   • `final_metrics` must include every key defined in ATIF v1.4 even if
 *     the value is `null` (null-when-absent, not omitted).
 *   • Trajectories with zero steps are NOT persisted — `writeTo` returns
 *     `false` in that case to avoid producing a file that fails Harbor's
 *     own validator.
 *   • Metrics are pulled from the SDK `stream.usage`; never estimated.
 *
 * The JSONL event stream emitted to stdout by the runner is a DIFFERENT
 * surface (internal protocol, not ATIF) — see `types.ts` for that contract.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ApprovalEvent,
  CompactionEvent,
  InterruptEvent,
  MetadataEvent,
  ObservationData,
  StepEvent,
  StepMetrics,
  ToolCallData,
} from "./types";

/**
 * Shape of a single ATIF v1.4 `Step` entry inside `trajectory.json`.
 *
 * Any field added here MUST be defined by ATIF v1.4 (or be ignored by the
 * spec as part of forward-compatible `extra`). Do not introduce ad-hoc
 * step-level fields — put them under `extra` instead.
 */
interface AtifStep {
  extra?: Record<string, unknown>;
  is_copied_context?: boolean;
  message: string;
  metrics?: StepMetrics;
  model_name?: string;
  observation?: ObservationData;
  reasoning_content?: string;
  reasoning_effort?: string | number;
  source: "agent" | "system" | "user";
  step_id: number;
  timestamp?: string;
  tool_calls?: ToolCallData[];
}

/**
 * Shape of the persisted ATIF v1.4 `Trajectory` JSON document.
 *
 * `schema_version` is the literal "ATIF-v1.4" and must match the Harbor
 * spec version this package targets. Bump it only when the underlying
 * Harbor spec bumps and this implementation has been audited against the
 * new version's required/optional fields.
 */
export interface TrajectoryJson {
  agent: { name: string; version: string; model_name: string };
  extra?: {
    approval_events?: ApprovalEvent[];
    compaction_events?: CompactionEvent[];
    interrupt_events?: InterruptEvent[];
  };
  final_metrics: {
    total_cached_tokens: number | null;
    total_completion_tokens: number | null;
    total_cost_usd: number | null;
    total_prompt_tokens: number | null;
    total_steps: number;
  };
  schema_version: "ATIF-v1.4";
  session_id: string;
  steps: AtifStep[];
}

interface MetricAccumulator {
  hasValue: boolean;
  total: number;
}

const DEFAULT_AGENT = {
  name: "unknown",
  version: "unknown",
  model_name: "unknown",
} as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function addMetric(
  accumulator: MetricAccumulator,
  value: number | undefined
): void {
  if (!isFiniteNumber(value)) {
    return;
  }

  accumulator.hasValue = true;
  accumulator.total += value;
}

function toMetricTotal(accumulator: MetricAccumulator): number | null {
  return accumulator.hasValue ? accumulator.total : null;
}

export class TrajectoryCollector {
  private approvalEvents: ApprovalEvent[] = [];
  private steps: StepEvent[] = [];
  private compactionEvents: CompactionEvent[] = [];
  private interruptEvents: InterruptEvent[] = [];
  private metadata: MetadataEvent | null = null;

  addApproval(event: ApprovalEvent): void {
    this.approvalEvents.push(event);
  }

  addStep(event: StepEvent): void {
    this.steps.push(event);
  }

  addCompaction(event: CompactionEvent): void {
    this.compactionEvents.push(event);
  }

  addMetadata(event: MetadataEvent): void {
    this.metadata = event;
  }

  addInterrupt(event: InterruptEvent): void {
    this.interruptEvents.push(event);
  }

  private collectFinalMetrics(): {
    total_cached_tokens: number | null;
    total_completion_tokens: number | null;
    total_cost_usd: number | null;
    total_prompt_tokens: number | null;
    total_steps: number;
  } {
    const prompt: MetricAccumulator = { hasValue: false, total: 0 };
    const completion: MetricAccumulator = { hasValue: false, total: 0 };
    const cached: MetricAccumulator = { hasValue: false, total: 0 };
    const cost: MetricAccumulator = { hasValue: false, total: 0 };

    for (const step of this.steps) {
      if (!("metrics" in step)) {
        continue;
      }

      const metrics: StepMetrics | undefined = step.metrics;
      if (!metrics) {
        continue;
      }

      addMetric(prompt, metrics.prompt_tokens);
      addMetric(completion, metrics.completion_tokens);
      addMetric(cached, metrics.cached_tokens);
      addMetric(cost, metrics.cost_usd);
    }

    return {
      total_prompt_tokens: toMetricTotal(prompt),
      total_completion_tokens: toMetricTotal(completion),
      total_cached_tokens: toMetricTotal(cached),
      total_cost_usd: toMetricTotal(cost),
      total_steps: this.steps.length,
    };
  }

  private toAtifStep(event: StepEvent): AtifStep {
    if (event.source !== "agent") {
      const { type: _type, ...rest } = event;
      return rest;
    }

    const { type: _type, metrics, ...rest } = event;
    const hasMetrics =
      metrics !== undefined &&
      Object.values(metrics).some((v) => v !== undefined);
    return hasMetrics ? { ...rest, metrics } : { ...rest };
  }

  finalize(): TrajectoryJson {
    const trajectory: TrajectoryJson = {
      schema_version: "ATIF-v1.4",
      session_id: this.metadata?.session_id ?? "unknown",
      agent: this.metadata?.agent ?? { ...DEFAULT_AGENT },
      steps: this.steps.map((s) => this.toAtifStep(s)),
      final_metrics: this.collectFinalMetrics(),
    };

    if (
      this.approvalEvents.length > 0 ||
      this.compactionEvents.length > 0 ||
      this.interruptEvents.length > 0
    ) {
      trajectory.extra = {
        ...(this.approvalEvents.length > 0
          ? { approval_events: [...this.approvalEvents] }
          : {}),
        ...(this.compactionEvents.length > 0
          ? { compaction_events: [...this.compactionEvents] }
          : {}),
        ...(this.interruptEvents.length > 0
          ? { interrupt_events: [...this.interruptEvents] }
          : {}),
      };
    }

    return trajectory;
  }

  /**
   * Persists the trajectory to disk in ATIF v1.4 format.
   *
   * Returns `true` when a file was written, `false` when the write was
   * skipped because the trajectory would violate the ATIF v1.4 shape
   * contract (currently: no steps emitted). Skipping is preferred over
   * writing an invalid document — Harbor's own validator rejects
   * `steps: []`, so a zero-step file is worse than no file for any
   * downstream consumer.
   */
  writeTo(outputPath: string): boolean {
    if (this.steps.length === 0) {
      return false;
    }
    const trajectory = this.finalize();
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(trajectory, null, 2), "utf-8");
    return true;
  }

  reset(): void {
    this.approvalEvents = [];
    this.steps = [];
    this.compactionEvents = [];
    this.interruptEvents = [];
    this.metadata = null;
  }
}
