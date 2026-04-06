import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CompactionEvent,
  MetadataEvent,
  StepEvent,
  StepMetrics,
} from "./types";

export interface TrajectoryJson {
  agent: { name: string; version: string; model_name: string };
  extra?: { compaction_events: CompactionEvent[] };
  final_metrics: {
    total_prompt_tokens: number | null;
    total_completion_tokens: number | null;
    total_cached_tokens: number | null;
    total_steps: number;
  };
  schema_version: "ATIF-v1.6";
  session_id: string;
  steps: StepEvent[];
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
  private steps: StepEvent[] = [];
  private compactionEvents: CompactionEvent[] = [];
  private metadata: MetadataEvent | null = null;

  addStep(event: StepEvent): void {
    this.steps.push(event);
  }

  addCompaction(event: CompactionEvent): void {
    this.compactionEvents.push(event);
  }

  addMetadata(event: MetadataEvent): void {
    this.metadata = event;
  }

  private collectFinalMetrics(): {
    total_prompt_tokens: number | null;
    total_completion_tokens: number | null;
    total_cached_tokens: number | null;
    total_steps: number;
  } {
    const prompt: MetricAccumulator = { hasValue: false, total: 0 };
    const completion: MetricAccumulator = { hasValue: false, total: 0 };
    const cached: MetricAccumulator = { hasValue: false, total: 0 };

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
    }

    return {
      total_prompt_tokens: toMetricTotal(prompt),
      total_completion_tokens: toMetricTotal(completion),
      total_cached_tokens: toMetricTotal(cached),
      total_steps: this.steps.length,
    };
  }

  finalize(): TrajectoryJson {
    const trajectory: TrajectoryJson = {
      schema_version: "ATIF-v1.6",
      session_id: this.metadata?.session_id ?? "unknown",
      agent: this.metadata?.agent ?? { ...DEFAULT_AGENT },
      steps: [...this.steps],
      final_metrics: this.collectFinalMetrics(),
    };

    if (this.compactionEvents.length > 0) {
      trajectory.extra = {
        compaction_events: [...this.compactionEvents],
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
    this.steps = [];
    this.compactionEvents = [];
    this.metadata = null;
  }
}
