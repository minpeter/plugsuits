# Benchmark Module - Harbor Integration

Harbor benchmark adapter for `terminal-bench@2.0`. Launches the agent and reads the ATIF trajectory produced by headless mode.

## Structure

```
benchmark/
├── harbor_agent.py       # BaseInstalledAgent implementation
└── install-agent.sh.j2   # Docker install script (Jinja2 template)
```

## Quick Commands

```bash
# Run single task
harbor run -d 'terminal-bench@2.0' \
  -t 'modernize-scientific-stack' \
  --agent-import-path benchmark.harbor_agent:CodeEditingAgent \
  -m 'Qwen/Qwen3-235B-A22B-Thinking-2507' \
  --force-build -n 1

# Run full benchmark
harbor run -d 'terminal-bench@2.0' \
  --agent-import-path benchmark.harbor_agent:CodeEditingAgent \
  -m 'Qwen/Qwen3-235B-A22B-Thinking-2507' \
  --force-build
```

## Configuration

Control agent behavior via environment variables:

| Variable | Values | Effect |
|----------|--------|--------|
| `AGENT_ENABLE_THINKING` | `1`, `true`, `yes` | Enable `--think` flag (captures reasoning content) |
| `AGENT_ENABLE_TOOL_FALLBACK` | `1`, `true`, `yes` | Enable `--tool-fallback` flag (XML-based tool calling for non-native models) |

## Event Flow (ATIF-v1.6)

```
headless.ts (Docker)          output.jsonl          harbor_agent.py
     │                            │                       │
     ├─► emit MetadataEvent ────► metadata ──────────────► session_id, agent info
     │                            │                       │
     ├─► emit StepEvent(user) ──► step (user) ───────────► Step(source="user")
     │                            │                       │
     ├─► emit ApprovalEvent ────► approval ──────────────► lifecycle annotation
     │                            │                       │
     ├─► emit CompactionEvent ──► compaction ────────────► (Lifecycle annotation)
     │                            │                       │
     ├─► emit InterruptEvent ───► interrupt ─────────────► lifecycle annotation
     │                            │                       │
     └─► emit StepEvent(agent) ─► step (agent) ──────────► Step(source="agent")
                                  │                       │
                                  └───────────────────────► trajectory.json (ATIF-v1.6, written by headless)
```

## Event Types (output.jsonl)

| Type | Fields | Notes |
|------|--------|-------|
| `metadata` | `session_id`, `agent`, `timestamp` | Emitted once at start |
| `step` | `step_id`, `source`, `message`, `tool_calls?`, `observation?`, `metrics?`, `reasoning_content?` | Sequential ATIF steps |
| `approval` | `state`, `toolCallId?`, `toolName?`, `reason?` | Approval lifecycle annotation (`pending/approved/denied`) |
| `compaction` | `event`, `tokensBefore`, `tokensAfter?`, `durationMs?` | History compaction events |
| `error` | `error`, `timestamp` | Fatal errors |
| `interrupt` | `reason`, `timestamp` | Intentional caller interruption |

## Verification

### 1. Event Type Distribution
```bash
cat jobs/<job_id>/*/agent/output.jsonl | jq -r '.type' | sort | uniq -c
# Expected output like:   1 metadata   N step   M compaction   K approval   optional interrupt (no unexpected 'error' lines)
```

### 2. Step ID Sequence
```bash
cat jobs/<job_id>/*/agent/output.jsonl | jq -r 'select(.type=="step") | .step_id'
# Expected: 1, 2, 3, ... (strictly increasing)
```

### 3. Trajectory Validation
```bash
python -m harbor.utils.trajectory_validator jobs/<job_id>/*/agent/trajectory.json
# Expected: ✓ Trajectory is valid
```

Validator expectations:
- `steps[*].source` is currently `user` or `agent`
- bundled tool observations live in `steps[*].observation.results`
- persisted lifecycle annotations, when present, live under `extra.approval_events`, `extra.compaction_events`, and `extra.interrupt_events`

### 4. Reasoning Content
```bash
cat jobs/<job_id>/*/agent/trajectory.json | jq '.steps[] | select(.reasoning_content != null) | {step_id, reasoning_len: (.reasoning_content | length)}'
```

## Key Implementation Details

### harbor_agent.py
- **Trajectory Reader**: `harbor_agent.py` reads the already-written `trajectory.json` and reports aggregate metrics.
- **No JSONL-to-ATIF Conversion**: headless mode writes the ATIF trajectory directly; benchmark code does not convert `output.jsonl` into `trajectory.json`.
- **Persisted Lifecycle Annotations**: `trajectory.json.extra` persists `approval_events`, `compaction_events`, and `interrupt_events`. Runtime `error` events stay in JSONL and are not copied into `trajectory.json` today.

### headless.ts
- **ATIF Native**: Emits `MetadataEvent` then a sequence of `StepEvent`s.
- **Bundled Observations**: Tool results are captured and included in the `observation` field of the following step.
- **SDK Usage**: Metrics and token counts are pulled directly from the AI SDK response.

## Anti-Patterns
- **NEVER** modify ATIF event types or lifecycle annotations without updating the benchmark contract docs and consumers.
- **NEVER** assume `step_id` is managed by the benchmark script; it is generated by the headless runner.
- **NEVER** estimate token counts; always use the provided `metrics`.
