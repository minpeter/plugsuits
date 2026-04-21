/**
 * ATIF v1.4 compliance test suite.
 *
 * These tests are load-bearing: they encode the Harbor ATIF v1.4 shape
 * contract (https://www.harborframework.com/docs/agents/trajectory-format)
 * as executable assertions. A regression here means `trajectory.json`
 * output no longer passes `harbor.utils.trajectory_validator`, which
 * breaks terminal-bench runs and any downstream scorer.
 *
 * Before loosening any assertion here, confirm the change is permitted by
 * the current Harbor spec version this package targets (`ATIF-v1.4`) and
 * that the Python validator in `packages/cea/benchmark/test_trajectory.py`
 * is updated in lock-step.
 */

import { describe, expect, it } from "vitest";
import { TrajectoryCollector } from "../trajectory-collector";
import type {
  AgentStepEvent,
  ApprovalEvent,
  CompactionEvent,
  ErrorEvent,
  InterruptEvent,
  MetadataEvent,
  StepEvent,
  StepMetrics,
  TrajectoryEvent,
  UserStepEvent,
} from "../types";

const timestamp = "2026-04-03T00:00:00.000Z";

function createMockStepEvent(
  overrides: Partial<AgentStepEvent> = {}
): AgentStepEvent {
  return {
    message: "assistant reply",
    source: "agent",
    step_id: 2,
    timestamp,
    type: "step",
    ...overrides,
  };
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("ATIF event serialization", () => {
  it("round-trips emitted step event variants with expected fields", () => {
    const userEvent: UserStepEvent = {
      message: "hello",
      source: "user",
      step_id: 1,
      timestamp,
      type: "step",
    };
    const agentEvent = createMockStepEvent({
      message: "done",
      metrics: { completion_tokens: 50, prompt_tokens: 100 },
      model_name: "mock-model",
      reasoning_content: "thinking",
    });
    expect(roundTrip(userEvent)).toStrictEqual(userEvent);
    expect(roundTrip(agentEvent)).toStrictEqual(agentEvent);
  });

  it("round-trips metadata, compaction, and error events without step ids", () => {
    const metadataEvent: MetadataEvent = {
      agent: { model_name: "gpt-5", name: "plugsuits", version: "1.6.0" },
      session_id: "session-1",
      timestamp,
      type: "metadata",
    };
    const compactionEvent: CompactionEvent = {
      event: "start",
      timestamp,
      tokensBefore: 2048,
      type: "compaction",
    };
    const errorEvent: ErrorEvent = {
      error: "iteration limit reached",
      timestamp,
      type: "error",
    };

    expect(roundTrip(metadataEvent)).toStrictEqual(metadataEvent);
    expect(roundTrip(compactionEvent)).toStrictEqual(compactionEvent);
    expect(roundTrip(errorEvent)).toStrictEqual(errorEvent);
    expect(compactionEvent).not.toHaveProperty("step_id");
    expect(metadataEvent).not.toHaveProperty("step_id");
    expect(errorEvent).not.toHaveProperty("step_id");
  });

  it("round-trips approval lifecycle events without step ids", () => {
    const approvalEvent: ApprovalEvent = {
      type: "approval",
      state: "pending",
      timestamp,
      toolCallId: "call_approval",
      toolName: "bash",
      reason: "Needs confirmation",
      providerExecuted: false,
    };

    expect(roundTrip(approvalEvent)).toStrictEqual(approvalEvent);
    expect(approvalEvent).not.toHaveProperty("step_id");
  });
});

describe("ATIF discriminants and sequencing", () => {
  it("narrows TrajectoryEvent by type and StepEvent by source", () => {
    const summarize = (event: TrajectoryEvent) => {
      if (event.type === "step") {
        if (event.source === "agent") {
          return event.model_name ?? event.message;
        }
        return event.message;
      }

      if (event.type === "metadata") {
        return event.session_id;
      }

      if (event.type === "approval") {
        return event.toolName ?? event.state;
      }

      if (event.type === "interrupt") {
        return event.reason;
      }

      return event.type === "compaction" ? event.event : event.error;
    };

    expect(
      summarize({
        message: "hello",
        source: "user",
        step_id: 1,
        timestamp,
        type: "step",
      })
    ).toBe("hello");
    expect(summarize(createMockStepEvent({ model_name: "mock-model" }))).toBe(
      "mock-model"
    );
    expect(
      summarize({
        agent: { model_name: "gpt-5", name: "plugsuits", version: "1.6.0" },
        session_id: "session-1",
        timestamp,
        type: "metadata",
      })
    ).toBe("session-1");
    expect(
      summarize({
        type: "approval",
        state: "pending",
        timestamp,
        toolCallId: "call_approval",
        toolName: "bash",
      })
    ).toBe("bash");
    expect(
      summarize({
        type: "interrupt",
        reason: "caller-abort",
        timestamp,
      })
    ).toBe("caller-abort");
  });

  it("round-trips interrupt lifecycle events without step ids", () => {
    const interruptEvent: InterruptEvent = {
      type: "interrupt",
      reason: "caller-abort",
      timestamp,
    };

    expect(roundTrip(interruptEvent)).toStrictEqual(interruptEvent);
    expect(interruptEvent).not.toHaveProperty("step_id");
  });

  it("keeps step ids sequential with no duplicates or gaps", () => {
    const events: StepEvent[] = [
      {
        message: "user asks",
        source: "user",
        step_id: 1,
        timestamp,
        type: "step",
      },
      createMockStepEvent({ message: "agent answers", step_id: 2 }),
    ];

    const stepIds = events.map((event) => event.step_id);

    expect(stepIds).toStrictEqual([1, 2]);
    expect(new Set(stepIds).size).toBe(stepIds.length);
    expect(stepIds.every((stepId, index) => stepId === index + 1)).toBe(true);
  });
});

describe("ATIF metrics and tool observation data", () => {
  it("uses ATIF metric keys and leaves metrics undefined when omitted", () => {
    const metrics: StepMetrics = {
      cached_tokens: 25,
      completion_tokens: 50,
      cost_usd: 0.12,
      prompt_tokens: 100,
    };
    const eventWithMetrics = createMockStepEvent({ metrics });
    const eventWithoutMetrics = createMockStepEvent({
      metrics: undefined,
      step_id: 3,
    });

    expect(roundTrip(eventWithMetrics).metrics).toStrictEqual(metrics);
    expect(
      Object.keys(roundTrip(eventWithMetrics).metrics ?? {}).sort()
    ).toStrictEqual([
      "cached_tokens",
      "completion_tokens",
      "cost_usd",
      "prompt_tokens",
    ]);
    expect(eventWithoutMetrics.metrics).toBeUndefined();
  });

  it("pairs tool calls with matching observation results across multiple items", () => {
    const event = createMockStepEvent({
      observation: {
        results: [
          { content: "first result", source_call_id: "call_1" },
          { content: "second result", source_call_id: "call_2" },
        ],
      },
      tool_calls: [
        {
          arguments: { path: "src/index.ts" },
          function_name: "read_file",
          tool_call_id: "call_1",
        },
        {
          arguments: { pattern: "TODO" },
          function_name: "grep",
          tool_call_id: "call_2",
        },
      ],
    });

    expect(event.tool_calls).toHaveLength(2);
    expect(event.observation?.results).toHaveLength(2);
    expect(event.tool_calls?.[0]?.tool_call_id).toBe(
      event.observation?.results[0]?.source_call_id
    );
    expect(event.tool_calls?.[1]?.tool_call_id).toBe(
      event.observation?.results[1]?.source_call_id
    );
  });
});

describe("ATIF compaction event structure", () => {
  it("models start events with tokensBefore and no tokensAfter", () => {
    const event: CompactionEvent = {
      event: "start",
      timestamp,
      tokensBefore: 4096,
      type: "compaction",
    };

    expect(event.tokensBefore).toBe(4096);
    expect(event.tokensAfter).toBeUndefined();
    expect(event).not.toHaveProperty("step_id");
  });

  it("models complete events with post-compaction details", () => {
    const event: CompactionEvent = {
      durationMs: 42,
      event: "complete",
      strategy: "summary",
      timestamp,
      tokensAfter: 512,
      tokensBefore: 4096,
      type: "compaction",
    };

    expect(event).toMatchObject({
      durationMs: 42,
      event: "complete",
      strategy: "summary",
      tokensAfter: 512,
      tokensBefore: 4096,
    });
  });

  it("models blocking change events with blocking state and reason", () => {
    const event: CompactionEvent = {
      blocking: true,
      event: "blocking_change",
      reason: "context limit reached",
      timestamp,
      tokensBefore: 4096,
      type: "compaction",
    };

    expect(event).toMatchObject({
      blocking: true,
      event: "blocking_change",
      reason: "context limit reached",
    });
  });
});

describe("ATIF JSONL shape", () => {
  it("round-trips a typical metadata → user → agent JSONL sequence", () => {
    const events: TrajectoryEvent[] = [
      {
        agent: { model_name: "gpt-5", name: "plugsuits", version: "1.6.0" },
        session_id: "session-1",
        timestamp,
        type: "metadata",
      },
      {
        message: "inspect src/index.ts",
        source: "user",
        step_id: 1,
        timestamp,
        type: "step",
      },
      createMockStepEvent({
        message: "I checked the file",
        step_id: 2,
        tool_calls: [
          {
            arguments: { path: "src/index.ts" },
            function_name: "read_file",
            tool_call_id: "call_1",
          },
        ],
      }),
    ];

    const parsed = events.map(
      (event) => JSON.parse(JSON.stringify(event)) as TrajectoryEvent
    );

    expect(parsed).toStrictEqual(events);
    expect(parsed[0]).toMatchObject({ type: "metadata" });
    expect(parsed[1]).toMatchObject({ source: "user", type: "step" });
    expect(parsed[2]).toMatchObject({ source: "agent", type: "step" });
  });

  it("omits session fields from individual step and error events", () => {
    const userEvent: UserStepEvent = {
      message: "hello",
      source: "user",
      step_id: 1,
      timestamp,
      type: "step",
    };
    const agentEvent = createMockStepEvent();
    const errorEvent: ErrorEvent = { error: "boom", timestamp, type: "error" };

    expect(userEvent).not.toHaveProperty("sessionId");
    expect(agentEvent).not.toHaveProperty("sessionId");
    expect(errorEvent).not.toHaveProperty("sessionId");
    expect(userEvent).not.toHaveProperty("session_id");
    expect(agentEvent).not.toHaveProperty("session_id");
    expect(errorEvent).not.toHaveProperty("session_id");
  });
});

const ATIF_STEP_ALLOWED_FIELDS = new Set([
  "step_id",
  "timestamp",
  "source",
  "model_name",
  "reasoning_effort",
  "message",
  "reasoning_content",
  "tool_calls",
  "observation",
  "metrics",
  "is_copied_context",
  "extra",
]);

const ATIF_TRAJECTORY_ALLOWED_FIELDS = new Set([
  "schema_version",
  "session_id",
  "agent",
  "steps",
  "notes",
  "final_metrics",
  "continued_trajectory_ref",
  "extra",
]);

const ATIF_AGENT_ALLOWED_FIELDS = new Set([
  "name",
  "version",
  "model_name",
  "tool_definitions",
  "extra",
]);

const ATIF_FINAL_METRICS_ALLOWED_FIELDS = new Set([
  "total_prompt_tokens",
  "total_completion_tokens",
  "total_cached_tokens",
  "total_cost_usd",
  "total_steps",
  "extra",
]);

describe("TrajectoryCollector ATIF compliance", () => {
  it("finalize() produces steps without the streaming 'type' discriminator", () => {
    const collector = new TrajectoryCollector();
    collector.addMetadata({
      type: "metadata",
      timestamp,
      session_id: "ses-1",
      agent: { name: "test", version: "1.0", model_name: "m1" },
    });
    collector.addStep({
      type: "step",
      step_id: 1,
      timestamp,
      source: "user",
      message: "hello",
    });
    collector.addStep({
      type: "step",
      step_id: 2,
      timestamp,
      source: "agent",
      message: "hi",
      model_name: "m1",
      tool_calls: [
        {
          tool_call_id: "c1",
          function_name: "search",
          arguments: { q: "test" },
        },
      ],
      observation: {
        results: [{ source_call_id: "c1", content: "result text" }],
      },
      metrics: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const trajectory = collector.finalize();

    for (const step of trajectory.steps) {
      expect(step).not.toHaveProperty("type");
      const keys = Object.keys(step);
      for (const key of keys) {
        expect(ATIF_STEP_ALLOWED_FIELDS.has(key)).toBe(true);
      }
    }
  });

  it("finalize() omits empty metrics from steps", () => {
    const collector = new TrajectoryCollector();
    collector.addMetadata({
      type: "metadata",
      timestamp,
      session_id: "ses-2",
      agent: { name: "test", version: "1.0", model_name: "m1" },
    });
    collector.addStep({
      type: "step",
      step_id: 1,
      timestamp,
      source: "user",
      message: "hi",
    });
    collector.addStep({
      type: "step",
      step_id: 2,
      timestamp,
      source: "agent",
      message: "reply",
      metrics: {},
    });

    const trajectory = collector.finalize();
    expect(trajectory.steps[1]).not.toHaveProperty("metrics");
  });

  it("finalize() preserves non-empty metrics", () => {
    const collector = new TrajectoryCollector();
    collector.addMetadata({
      type: "metadata",
      timestamp,
      session_id: "ses-3",
      agent: { name: "test", version: "1.0", model_name: "m1" },
    });
    collector.addStep({
      type: "step",
      step_id: 1,
      timestamp,
      source: "user",
      message: "hi",
    });
    collector.addStep({
      type: "step",
      step_id: 2,
      timestamp,
      source: "agent",
      message: "reply",
      metrics: { prompt_tokens: 100 },
    });

    const trajectory = collector.finalize();
    expect(trajectory.steps[1]?.metrics).toEqual({ prompt_tokens: 100 });
  });

  it("finalize() root object contains only ATIF-allowed fields", () => {
    const collector = new TrajectoryCollector();
    collector.addMetadata({
      type: "metadata",
      timestamp,
      session_id: "ses-4",
      agent: { name: "a", version: "1", model_name: "m" },
    });
    collector.addStep({
      type: "step",
      step_id: 1,
      timestamp,
      source: "user",
      message: "hi",
    });

    const trajectory = collector.finalize();
    for (const key of Object.keys(trajectory)) {
      expect(ATIF_TRAJECTORY_ALLOWED_FIELDS.has(key)).toBe(true);
    }
    for (const key of Object.keys(trajectory.agent)) {
      expect(ATIF_AGENT_ALLOWED_FIELDS.has(key)).toBe(true);
    }
    for (const key of Object.keys(trajectory.final_metrics)) {
      expect(ATIF_FINAL_METRICS_ALLOWED_FIELDS.has(key)).toBe(true);
    }
  });

  it("finalize() step_ids are sequential starting from 1", () => {
    const collector = new TrajectoryCollector();
    collector.addMetadata({
      type: "metadata",
      timestamp,
      session_id: "ses-5",
      agent: { name: "a", version: "1", model_name: "m" },
    });
    collector.addStep({
      type: "step",
      step_id: 1,
      timestamp,
      source: "user",
      message: "1",
    });
    collector.addStep({
      type: "step",
      step_id: 2,
      timestamp,
      source: "agent",
      message: "2",
    });
    collector.addStep({
      type: "step",
      step_id: 3,
      timestamp,
      source: "agent",
      message: "3",
    });

    const trajectory = collector.finalize();
    trajectory.steps.forEach((step, i) => {
      expect(step.step_id).toBe(i + 1);
    });
  });

  it("finalize() aggregates total_cost_usd across step metrics", () => {
    const collector = new TrajectoryCollector();
    collector.addMetadata({
      type: "metadata",
      timestamp,
      session_id: "ses-cost",
      agent: { name: "a", version: "1", model_name: "m" },
    });
    collector.addStep({
      type: "step",
      step_id: 1,
      timestamp,
      source: "user",
      message: "hi",
    });
    collector.addStep({
      type: "step",
      step_id: 2,
      timestamp,
      source: "agent",
      message: "a",
      metrics: { cost_usd: 0.12, prompt_tokens: 100 },
    });
    collector.addStep({
      type: "step",
      step_id: 3,
      timestamp,
      source: "agent",
      message: "b",
      metrics: { cost_usd: 0.08, prompt_tokens: 80 },
    });

    const trajectory = collector.finalize();
    expect(trajectory.final_metrics.total_cost_usd).toBeCloseTo(0.2, 10);
    expect(trajectory.final_metrics.total_prompt_tokens).toBe(180);
  });

  it("finalize() returns null total_cost_usd when no step reported a cost", () => {
    const collector = new TrajectoryCollector();
    collector.addMetadata({
      type: "metadata",
      timestamp,
      session_id: "ses-no-cost",
      agent: { name: "a", version: "1", model_name: "m" },
    });
    collector.addStep({
      type: "step",
      step_id: 1,
      timestamp,
      source: "user",
      message: "hi",
    });
    collector.addStep({
      type: "step",
      step_id: 2,
      timestamp,
      source: "agent",
      message: "a",
      metrics: { prompt_tokens: 100 },
    });

    const trajectory = collector.finalize();
    expect(trajectory.final_metrics.total_cost_usd).toBeNull();
  });

  it("finalize() preserves ATIF-v1.4 optional fields (logprobs, prompt_token_ids, completion_token_ids)", () => {
    const collector = new TrajectoryCollector();
    collector.addMetadata({
      type: "metadata",
      timestamp,
      session_id: "ses-v14",
      agent: { name: "a", version: "1", model_name: "m" },
    });
    collector.addStep({
      type: "step",
      step_id: 1,
      timestamp,
      source: "user",
      message: "hi",
    });
    collector.addStep({
      type: "step",
      step_id: 2,
      timestamp,
      source: "agent",
      message: "reply",
      metrics: {
        completion_token_ids: [1722, 310, 5533],
        logprobs: [-0.1, -0.05, -0.02],
        prompt_token_ids: [1, 2, 3],
        prompt_tokens: 3,
      },
    });

    const trajectory = collector.finalize();
    const agentStep = trajectory.steps[1];
    expect(agentStep?.metrics?.logprobs).toStrictEqual([-0.1, -0.05, -0.02]);
    expect(agentStep?.metrics?.prompt_token_ids).toStrictEqual([1, 2, 3]);
    expect(agentStep?.metrics?.completion_token_ids).toStrictEqual([
      1722, 310, 5533,
    ]);
  });

  it("finalize() observation source_call_ids reference valid tool_call_ids", () => {
    const collector = new TrajectoryCollector();
    collector.addMetadata({
      type: "metadata",
      timestamp,
      session_id: "ses-6",
      agent: { name: "a", version: "1", model_name: "m" },
    });
    collector.addStep({
      type: "step",
      step_id: 1,
      timestamp,
      source: "user",
      message: "go",
    });
    collector.addStep({
      type: "step",
      step_id: 2,
      timestamp,
      source: "agent",
      message: "done",
      tool_calls: [
        { tool_call_id: "c1", function_name: "f1", arguments: {} },
        { tool_call_id: "c2", function_name: "f2", arguments: {} },
      ],
      observation: {
        results: [
          { source_call_id: "c1", content: "r1" },
          { source_call_id: "c2", content: "r2" },
        ],
      },
    });

    const trajectory = collector.finalize();
    for (const step of trajectory.steps) {
      if (step.observation && step.tool_calls) {
        const toolCallIds = new Set(
          step.tool_calls.map((tc) => tc.tool_call_id)
        );
        for (const result of step.observation.results) {
          expect(toolCallIds.has(result.source_call_id)).toBe(true);
        }
      }
    }
  });
});
