import { describe, expect, it } from "vitest";
import type {
  AgentStepEvent,
  CompactionEvent,
  ErrorEvent,
  MetadataEvent,
  StepEvent,
  StepMetrics,
  SystemStepEvent,
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
  it("round-trips all step event variants with expected fields", () => {
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
    const systemEvent: SystemStepEvent = {
      message: "tool observation",
      observation: { results: [{ content: "ok", source_call_id: "call_1" }] },
      source: "system",
      step_id: 3,
      timestamp,
      type: "step",
    };

    expect(roundTrip(userEvent)).toStrictEqual(userEvent);
    expect(roundTrip(agentEvent)).toStrictEqual(agentEvent);
    expect(roundTrip(systemEvent)).toStrictEqual(systemEvent);
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
});

describe("ATIF discriminants and sequencing", () => {
  it("narrows TrajectoryEvent by type and StepEvent by source", () => {
    const summarize = (event: TrajectoryEvent) => {
      if (event.type === "step") {
        if (event.source === "agent") {
          return event.model_name ?? event.message;
        }
        if (event.source === "system") {
          return event.observation?.results[0]?.content ?? event.message;
        }
        return event.message;
      }

      if (event.type === "metadata") {
        return event.session_id;
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
        message: "system",
        observation: {
          results: [{ content: "observed", source_call_id: "call_1" }],
        },
        source: "system",
        step_id: 3,
        timestamp,
        type: "step",
      })
    ).toBe("observed");
    expect(
      summarize({
        agent: { model_name: "gpt-5", name: "plugsuits", version: "1.6.0" },
        session_id: "session-1",
        timestamp,
        type: "metadata",
      })
    ).toBe("session-1");
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
