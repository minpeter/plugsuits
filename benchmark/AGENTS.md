# Benchmark Module - Harbor Integration

Harbor benchmark adapter for `terminal-bench@2.0`. Converts agent output to ATIF trajectory format.

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

# Run with reasoning + tool fallback (for models without native tool support)
AGENT_ENABLE_THINKING=1 AGENT_ENABLE_TOOL_FALLBACK=1 \
harbor run -d 'terminal-bench@2.0' \
  -t 'modernize-scientific-stack' \
  --agent-import-path benchmark.harbor_agent:CodeEditingAgent \
  -m 'zhipuai-org/GLM-4.6' \
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

## Event Flow

```
headless.ts (Docker)          output.jsonl          harbor_agent.py
     │                            │                       │
     ├─► emit UserEvent ────────► user ─────────────────► Step(source="user")
     │                            │                       │
     ├─► emit ToolCallEvent ────► tool_call ────────────► Step(source="agent", tool_calls=[...])
     │                            │                       │
     ├─► emit ToolResultEvent ──► tool_result ──────────► (matched to Step by tool_call_id)
     │                            │                       │
     └─► emit AssistantEvent ───► assistant ────────────► Step(source="agent", message=...)
                                  │                       │
                                  └───────────────────────► trajectory.json (ATIF-v1.4)
```

## Event Types (output.jsonl)

| Type | Fields | Notes |
|------|--------|-------|
| `user` | `content` | User prompt |
| `tool_call` | `tool_call_id`, `tool_name`, `tool_input`, `model`, `reasoning_content?` | LLM tool invocation |
| `tool_result` | `tool_call_id`, `output`, `error?`, `exit_code?` | Tool execution result |
| `assistant` | `content`, `model`, `reasoning_content?` | Final text response |
| `error` | `error` | Fatal errors |

## Verification

### 1. Event Type Distribution
```bash
cat jobs/<job_id>/*/agent/output.jsonl | jq -r '.type' | sort | uniq -c
# Expected: user=1, tool_call=N, tool_result=N, assistant=1
```

### 2. Tool Call Matching
```bash
# All tool_calls must have matching tool_result
diff <(cat jobs/<job_id>/*/agent/output.jsonl | jq -r 'select(.type=="tool_call") | .tool_call_id' | sort) \
     <(cat jobs/<job_id>/*/agent/output.jsonl | jq -r 'select(.type=="tool_result") | .tool_call_id' | sort)
# Should output nothing (identical)
```

### 3. Trajectory Validation
```bash
python -m harbor.utils.trajectory_validator jobs/<job_id>/*/agent/trajectory.json
# Expected: ✓ Trajectory is valid
# Note: Run in harbor's Python environment (e.g., `uv run` or activated venv)
```

### 4. Reasoning Content (Thinking Models)
```bash
cat jobs/<job_id>/*/agent/trajectory.json | jq '.steps[] | select(.reasoning_content != null) | {step_id, reasoning_len: (.reasoning_content | length)}'
# Should show reasoning for thinking models (e.g., Qwen3-235B-A22B-Thinking-2507)
```

### 5. Full Result
```bash
cat jobs/<job_id>/result.json | jq '{task: .task_name, reward: .verifier_result.rewards.reward}'
```

## Key Implementation Details

### harbor_agent.py

**`_convert_events_to_trajectory()`**: Converts `output.jsonl` → ATIF trajectory
- Handles parallel tool calls: searches ALL previous steps backwards to match `tool_call_id`
- Merges `error` field into `output` for tool results
- Preserves `reasoning_content` from thinking models

**`create_run_agent_commands()`**: Docker execution
- Sets `FRIENDLI_TOKEN` env var
- Passes model via `-m` flag
- Outputs to `/logs/agent/output.jsonl`

### headless.ts

**Stream event handlers**:
- `text-delta`: Accumulates assistant text
- `reasoning-delta`: Captures thinking model reasoning
- `tool-call`: Emits `tool_call` event with accumulated reasoning
- `tool-result`: Emits `tool_result` with output/error/exit_code
- `tool-error`: Converts to `tool_result` with error field

## Available Models (FriendliAI)

| Model | Type | Notes |
|-------|------|-------|
| `Qwen/Qwen3-235B-A22B-Instruct-2507` | Instruct | Default |
| `Qwen/Qwen3-235B-A22B-Thinking-2507` | Thinking | Generates `reasoning_content` |
| `LGAI-EXAONE/K-EXAONE-236B-A23B` | Instruct | Korean-optimized |
| `meta-llama/Llama-4-Maverick-17B-128E-Instruct` | Instruct | Lightweight |

## Debugging

### Build Issues
```bash
# Force rebuild Docker image
harbor run ... --force-build
```

### Missing Trajectory
```bash
# Check if output.jsonl exists
ls -la jobs/<job_id>/*/agent/

# Check Docker logs
cat jobs/<job_id>/*/agent/output.jsonl | head -20
```

### Tool Result Mismatch
If tool_call count ≠ tool_result count:
1. Check for `tool-error` events not being captured
2. Verify headless.ts handles all error types
3. Check for timeout/crash mid-execution

## Anti-Patterns

- **NEVER** hardcode absolute paths (`/app/...`) in agent prompts - use relative paths
- **NEVER** skip trajectory validation after changes
- **NEVER** modify event types without updating `_convert_events_to_trajectory()`

---

## References

- [ATIF Trajectory Format](https://harborframework.com/docs/trajectory-format) - Schema specification for trajectory.json
- [Harbor Agents Guide](https://harborframework.com/docs/agents) - BaseInstalledAgent implementation details
- [Running Terminal-Bench](https://harborframework.com/docs/running-tbench) - Benchmark execution and configuration
