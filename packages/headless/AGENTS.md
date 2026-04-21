# HEADLESS PACKAGE — AGENT KNOWLEDGE BASE

Package: `@ai-sdk-tool/headless`
Source: `packages/headless/src/`

## OVERVIEW

This package provides a non-interactive, JSONL event-streaming runtime for agent sessions. Instead of rendering to a terminal, it writes structured events to stdout — one JSON object per line. This makes it suitable for CI/CD pipelines, benchmarks, and any programmatic consumer that needs a machine-readable transcript.

The package depends on `@ai-sdk-tool/harness` for `CheckpointHistory`, `AgentStreamResult`, and `shouldContinueManualToolLoop`. The agent itself is passed in as a config parameter.

## JSONL EVENT PROTOCOL

Every event is a JSON object on its own line.

> **This JSONL stream is NOT the ATIF schema.** ATIF is the format of the
> persisted `trajectory.json` file produced by `TrajectoryCollector` — see
> [Harbor's ATIF specification](https://www.harborframework.com/docs/agents/trajectory-format).
> The current ATIF version is **v1.4**. This JSONL protocol is an internal
> streaming contract used by the runner to drive UI, telemetry, and the
> trajectory collector. Persisted lifecycle annotations (`approval`,
> `compaction`, `interrupt`) are bundled into ATIF `extra.*` buckets by the
> collector — they are NOT `steps[*].source` values, but they do survive
> on disk. Transient annotations (`turn-start`, `error`) stay JSONL-only
> and are never written to `trajectory.json`.

### Design Decisions
- **NO sessionId on individual events**: A single `MetadataEvent` at the start carries the `session_id`.
- **Bundled Observations**: Tool results are not separate events; they are bundled into the `AgentStepEvent.observation` field of the next agent step.
- **Sequential Step IDs**: `step_id` fields are sequential integers starting from 1, strictly increasing across all step events.
- **Lifecycle Annotations**: `ApprovalEvent`, `CompactionEvent`, `ErrorEvent`, and `InterruptEvent` are lifecycle annotations and do not have a `step_id`.
- **Strict Metrics**: Metrics come directly from the SDK `stream.usage` and are never estimated.

### Event Types

| Type | Source | Description |
|------|--------|-------------|
| `metadata` | system | Emitted once at start with session and agent info |
| `step` | `user` | A user message step |
| `step` | `agent` | An agent response (text, reasoning, tool calls, observations) |
| `approval` | system | Structured tool approval lifecycle (`pending`, `approved`, `denied`) |
| `compaction` | system | Lifecycle event for history compaction |
| `error` | system | Fatal or iteration-limit error |
| `interrupt` | system | Intentional caller interruption (`caller-abort`) |
| `turn-start` | system | Lifecycle annotation emitted right after `agent.stream()` is invoked, before the first chunk arrives |

### Examples

**MetadataEvent**:
```json
{"type":"metadata","timestamp":"2026-04-03T10:00:00.000Z","session_id":"ses-abc123","agent":{"name":"code-editing-agent","version":"1.0.0","model_name":"gpt-4o"}}
```

**StepEvent (User)**:
```json
{"type":"step","step_id":1,"timestamp":"2026-04-03T10:00:00.000Z","source":"user","message":"Fix the bug"}
```

**StepEvent (Agent — text only)**:
```json
{"type":"step","step_id":2,"timestamp":"2026-04-03T10:00:01.000Z","source":"agent","message":"I'll fix it.","model_name":"gpt-4o","metrics":{"prompt_tokens":520,"completion_tokens":80}}
```

**StepEvent (Agent — with tools and observations)**:
```json
{"type":"step","step_id":3,"timestamp":"2026-04-03T10:00:05.000Z","source":"agent","message":"I've read the file.","model_name":"gpt-4o","tool_calls":[{"tool_call_id":"call_1","function_name":"read_file","arguments":{"path":"src/index.ts"}}],"observation":{"results":[{"source_call_id":"call_1","content":"{\"stdout\":\"...file contents...\"}"}]},"metrics":{"prompt_tokens":420,"completion_tokens":60}}
```

**CompactionEvent**:
```json
{"type":"compaction","timestamp":"2026-04-03T10:00:10.000Z","event":"start","tokensBefore":45000}
{"type":"compaction","timestamp":"2026-04-03T10:00:11.200Z","event":"complete","tokensBefore":45000,"tokensAfter":12000,"strategy":"session-memory","durationMs":1200}
{"type":"compaction","timestamp":"2026-04-03T10:00:15.000Z","event":"blocking_change","tokensBefore":128000,"blocking":true,"reason":"hard_limit"}
```

**ApprovalEvent**:
```json
{"type":"approval","timestamp":"2026-04-03T10:00:06.000Z","state":"pending","toolCallId":"call_1","toolName":"bash","reason":"Needs confirmation"}
{"type":"approval","timestamp":"2026-04-03T10:00:07.000Z","state":"approved","toolCallId":"call_1","toolName":"bash"}
```

**InterruptEvent**:
```json
{"type":"interrupt","timestamp":"2026-04-03T10:00:20.000Z","reason":"caller-abort"}
```

**ErrorEvent**:
```json
{"type":"error","timestamp":"2026-04-03T10:00:20.000Z","error":"Max iterations (50) reached"}
```

**TurnStartEvent**:
```json
{"type":"turn-start","timestamp":"2026-04-03T10:00:04.500Z","phase":"new-turn"}
```

## KEY EXPORTS

### `runHeadless(config: HeadlessRunnerConfig): Promise<void>`

The main entrypoint. Runs the agent loop, emitting JSONL events for each turn.

### `emitEvent(event: TrajectoryEvent): void`

Writes a single `TrajectoryEvent` as a JSONL line to stdout.

### `registerSignalHandlers(config: SignalHandlerConfig): void`

Registers process signal handlers for graceful shutdown.

### Event types

```typescript
import type {
  TrajectoryEvent,
  StepEvent,
  UserStepEvent,
  AgentStepEvent,
  MetadataEvent,
  CompactionEvent,
  ErrorEvent,
  ApprovalEvent,
  InterruptEvent,
} from "@ai-sdk-tool/headless";
```

## FILE MAP

| File | Exports | Role |
|------|---------|------|
| `runner.ts` | `runHeadless` | Main agent loop with JSONL emission |
| `emit.ts` | `emitEvent` | Default stdout JSONL event sink |
| `signals.ts` | `registerSignalHandlers` | Process signal lifecycle management |
| `types.ts` | `TrajectoryEvent`, etc. | JSONL stream event types (internal) + ATIF-v1.4 persisted types |

## CONVENTIONS

- This package must not import from `@ai-sdk-tool/cea` or `@ai-sdk-tool/tui`.
- `step_id` must be sequential and strictly increasing.
- Tool results must be bundled into `observation.results`.
- Approval and interruption lifecycle events are additive machine-readable annotations and do not carry `step_id`.

## ANTI-PATTERNS

- Using old event types (`user`, `assistant`, `tool_call`, `tool_result` as separate types).
- Including `sessionId` on every event (use `MetadataEvent` once).
- Estimating token counts (use `metrics` from SDK only).
- Manual `step_id` management outside the runner.
- Using `console.log` for non-event output.

## ATIF v1.4 COMPLIANCE (persisted trajectory.json)

`TrajectoryCollector` writes the only output that MUST conform to Harbor's ATIF v1.4 spec (<https://www.harborframework.com/docs/agents/trajectory-format>). When editing `trajectory-collector.ts` or `collectTrajectoryEvent` in `runner.ts`, keep the following invariants:

- **schema_version is the literal `"ATIF-v1.4"`**. Never bump unilaterally — bump only when the upstream Harbor spec bumps and this implementation has been audited against the new version's required/optional fields.
- **`steps[*].source` ∈ `{user, agent, system}`**. Never widen this set; new event types go to `extra.*` or are dropped from persistence.
- **Persisted lifecycle annotations live under `extra.*`**: `approval_events`, `compaction_events`, `interrupt_events`. Extending this set is acceptable (ATIF `extra` is forward-compatible) but each new bucket requires a new collector method and a corresponding `collectTrajectoryEvent` case.
- **Adding a JSONL event type is additive for stdout** but requires an explicit routing decision in `collectTrajectoryEvent`: persist under `extra.*`, or drop. Leaving the `default: return;` fallthrough is a valid choice for transient signals (the pattern `turn-start` uses).
- **`final_metrics` keys are null-when-absent, not omitted**. The shape is load-bearing for downstream tools (Harbor validator, scorer).
- **Metrics come from SDK `stream.usage`** — never estimated; never hand-filled.

Violating these invariants silently breaks Harbor benchmark runs, since the persisted trajectory will fail `harbor.utils.trajectory_validator` or produce unusable scorer output.
