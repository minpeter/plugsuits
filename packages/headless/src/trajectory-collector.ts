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

export interface TrajectoryJson {
  agent: { name: string; version: string; model_name: string };
  extra?: {
    approval_events?: ApprovalEvent[];
    compaction_events?: CompactionEvent[];
    interrupt_events?: InterruptEvent[];
  } & Record<string, unknown>;
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

  writeTo(outputPath: string): void {
    const trajectory = this.finalize();
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(trajectory, null, 2), "utf-8");
  }

  reset(): void {
    this.approvalEvents = [];
    this.steps = [];
    this.compactionEvents = [];
    this.interruptEvents = [];
    this.metadata = null;
  }
}
