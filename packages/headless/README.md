# @ai-sdk-tool/headless

A non-interactive, JSONL event-streaming runtime for agent sessions. Instead of rendering to a terminal, it writes structured events to stdout — one JSON object per line. Suitable for CI/CD pipelines, benchmarks, and any programmatic consumer that needs a machine-readable transcript.

## Installation

```bash
pnpm add @ai-sdk-tool/headless
# or
npm install @ai-sdk-tool/headless
```

**Peer dependencies:**

```bash
pnpm add @ai-sdk-tool/harness ai
```

## Quick Start

```typescript
import { createAgent, CheckpointHistory, SessionManager } from "@ai-sdk-tool/harness";
import { runHeadless, registerSignalHandlers } from "@ai-sdk-tool/headless";
import { openai } from "@ai-sdk/openai";

const session = new SessionManager();
const sessionId = session.initialize();

const messageHistory = new CheckpointHistory();
const agent = await createAgent({
  model: openai("gpt-4o"),
  instructions: "You are a helpful assistant.",
});

// Register signal handlers before any async work
registerSignalHandlers({
  onCleanup: () => {},
  onFatalCleanup: (exitCode) => process.exit(exitCode),
});

// Run the agent — emits JSONL events to stdout
await runHeadless({
  agent,
  initialUserMessage: {
    content: "Fix the type error in src/index.ts",
  },
  modelId: "gpt-4o",
  sessionId,
  messageHistory,
});
```

**Example output (JSONL stream):**

```jsonl
{"type":"metadata","timestamp":"2026-04-03T10:00:00.000Z","session_id":"ses-abc123","agent":{"name":"code-editing-agent","version":"1.0.0","model_name":"gpt-4o"}}
{"type":"step","step_id":1,"timestamp":"2026-04-03T10:00:00.000Z","source":"user","message":"Fix the type error in src/index.ts"}
{"type":"step","step_id":2,"timestamp":"2026-04-03T10:00:01.000Z","source":"agent","message":"I'll inspect the file.","model_name":"gpt-4o","tool_calls":[{"tool_call_id":"call_1","function_name":"read_file","arguments":{"path":"src/index.ts"}}],"observation":{"results":[{"source_call_id":"call_1","content":"{\"stdout\":\"...file contents...\"}"}]},"metrics":{"prompt_tokens":520,"completion_tokens":80}}
{"type":"step","step_id":3,"timestamp":"2026-04-03T10:00:03.000Z","source":"agent","message":"I found the issue and fixed it.","model_name":"gpt-4o","metrics":{"prompt_tokens":410,"completion_tokens":65}}
```

## API Reference

### `runHeadless(config)`

Runs the agent loop, emitting JSONL events for each turn. Continues looping while the agent makes tool calls. Optionally continues after the main loop if there are incomplete TODO items.

```typescript
import { runHeadless } from "@ai-sdk-tool/headless";

await runHeadless({
  agent,           // RunnableAgent — required
  sessionId,       // string — becomes metadata.session_id
  messageHistory,  // CheckpointHistory from @ai-sdk-tool/harness
  modelId,         // string — current model ID for metadata and agent steps
  initialUserMessage, // optional initial user turn
  maxIterations,   // optional number — safety cap on loop iterations
  maxTodoReminders, // optional number — cap follow-up TODO reminder turns
  measureUsage,    // optional async usage probe for tighter budgeting
  emitEvent,       // optional (event: TrajectoryEvent) => void — defaults to stdout JSONL
  circuitBreaker,  // optional compaction circuit breaker
  compactionCallbacks, // optional compaction lifecycle callbacks
  disableCompaction, // optional boolean to skip automatic compaction
  onBeforeTurn,    // optional async hook before each stream call
  onInterrupt,     // optional (event: InterruptEvent) => void — caller-abort lifecycle hook
  onTurnComplete,  // optional receives messages, usage, snapshot, finishReason
  onTodoReminder,  // optional () => Promise<{ hasReminder, message }> — TODO continuation
  shouldContinue,  // optional override for the default tool-loop continuation gate
  streamTimeoutMs, // optional stream response timeout override
  atifOutputPath,  // optional path for writing trajectory.json directly
});
```

**Config fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | `RunnableAgent` | yes | Agent with a `stream(opts)` method |
| `sessionId` | `string` | yes | Unique ID emitted once as `metadata.session_id` |
| `messageHistory` | `CheckpointHistory` | yes | Conversation history — read and written during the loop |
| `modelId` | `string` | yes | Current model ID for metadata and `step` events |
| `initialUserMessage` | `{ content, eventContent?, originalContent? }` | no | Bootstraps the first user turn without mutating history manually |
| `maxIterations` | `number` | no | Total iteration budget across the entire headless run, including TODO reminder turns; emits an `error` event and stops if exceeded |
| `maxTodoReminders` | `number` | no | Caps TODO reminder follow-up turns without lowering the main loop iteration budget |
| `measureUsage` | `(messages) => Promise<UsageMeasurement \| null>` | no | Optional usage probe used to tighten the next stream budget |
| `emitEvent` | `(event) => void` | no | Custom event sink; defaults to `console.log(JSON.stringify(event))` |
| `circuitBreaker` | `CompactionCircuitBreaker` | no | Circuit breaker controlling automatic compaction retries |
| `compactionCallbacks` | `CompactionOrchestratorCallbacks` | no | Lifecycle callbacks for compaction events |
| `disableCompaction` | `boolean` | no | Disables automatic compaction entirely |
| `onBeforeTurn` | `(phase) => BeforeTurnResult \| Promise<BeforeTurnResult \| undefined> \| undefined` | no | Runs before each stream call and can override stream options |
| `onInterrupt` | `(event: InterruptEvent) => void` | no | Called when the caller aborts the active run |
| `onTurnComplete` | `(messages, usage?, snapshot?, finishReason?) => void \| Promise<void>` | no | Runs after each completed turn with usage and snapshot metadata |
| `onTodoReminder` | `() => Promise<{ hasReminder, message }>` | no | Called after the main loop; if `hasReminder` is true, sends `message` as a user turn and continues |
| `shouldContinue` | `(finishReason) => boolean` | no | Overrides the default continuation predicate |
| `streamTimeoutMs` | `number` | no | Overrides the default stream response timeout |
| `atifOutputPath` | `string` | no | Writes the collected ATIF trajectory JSON to disk after the run |

---

### `emitEvent(event)`

Writes a single `TrajectoryEvent` as a JSONL line to stdout. This is the default event sink used by `runHeadless`.

```typescript
import { emitEvent } from "@ai-sdk-tool/headless";

emitEvent({
  type: "interrupt",
  reason: "caller-abort",
  timestamp: new Date().toISOString(),
});
// stdout: {"type":"interrupt","reason":"caller-abort","timestamp":"..."}
```

---

### `registerSignalHandlers(config)`

Registers process signal handlers for graceful shutdown. Handles `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, `uncaughtException`, and `unhandledRejection`.

```typescript
import { registerSignalHandlers } from "@ai-sdk-tool/headless";

registerSignalHandlers({
  onCleanup: () => {
    // Called on process exit — flush buffers, write final state
    flushOutputBuffer();
  },
  onFatalCleanup: (exitCode) => {
    // Must call process.exit — typed as `never` to enforce this
    process.exit(exitCode);
  },
});
```

**Exit codes by signal:**

| Signal | Exit code |
|--------|-----------|
| `SIGINT` | 0 |
| `SIGTERM` | 143 |
| `SIGHUP` | 129 |
| `SIGQUIT` | 131 |
| `uncaughtException` / `unhandledRejection` | 1 |

**Important:** Uses `process.once` — calling `registerSignalHandlers` twice for the same signal is a bug. Call it once at startup.

---

## JSONL Event Types

The runner streams an internal JSONL event protocol documented in `packages/headless/AGENTS.md`. The persisted `trajectory.json` produced by `TrajectoryCollector` conforms to Harbor's **ATIF-v1.4** schema (<https://www.harborframework.com/docs/agents/trajectory-format>). Lifecycle annotations on the JSONL stream split into two categories: `approval`, `compaction`, and `interrupt` are persisted into `trajectory.extra.*` buckets (not as `steps[*].source` values); `turn-start` and `error` are transient and stay JSONL-only.

### Event overview

| Type | Source | Description |
|------|--------|-------------|
| `metadata` | system | Emitted once at start with `session_id` and agent info |
| `step` | `user` | A user message step |
| `step` | `agent` | An agent response, including text, reasoning, tool calls, and optional observations |
| `approval` | system | Structured tool approval lifecycle (`pending`, `approved`, `denied`) |
| `compaction` | system | Lifecycle event for history compaction |
| `error` | system | Fatal error or iteration-limit event |
| `interrupt` | system | Intentional caller interruption (`caller-abort`) |
| `turn-start` | system | Lifecycle annotation emitted right after `agent.stream()` is dispatched, before the first chunk arrives |

### `metadata`

```typescript
{
  type: "metadata",
  timestamp: string,
  session_id: string,
  agent: {
    name: string,
    version: string,
    model_name: string,
  },
}
```

### `step`

```typescript
{
  type: "step",
  step_id: number,
  timestamp: string,
  source: "user" | "agent",
  message?: string,
  model_name?: string,
  tool_calls?: Array<{
    tool_call_id: string,
    function_name: string,
    arguments: Record<string, unknown>,
  }>,
  observation?: {
    results: Array<{
      source_call_id: string,
      content: string,
    }>,
  },
  metrics?: {
    prompt_tokens: number,
    completion_tokens: number,
    cached_tokens?: number,
    cost_usd?: number,
  },
}
```

### `compaction`

```typescript
{
  type: "compaction",
  timestamp: string,
  event: "start" | "complete" | "blocking_change",
  tokensBefore: number,
  tokensAfter?: number,
  strategy?: string,
  durationMs?: number,
  blocking?: boolean,
  reason?: string,
}
```

### `approval`

```typescript
{
  type: "approval",
  timestamp: string,
  state: "pending" | "approved" | "denied",
  toolCallId?: string,
  toolName?: string,
  reason?: string,
  providerExecuted?: boolean,
}
```

### `error`

```typescript
{
  type: "error",
  timestamp: string,
  error: string,
}
```

### `interrupt`

```typescript
{
  type: "interrupt",
  timestamp: string,
  reason: "caller-abort",
}
```

### `turn-start`

```typescript
{
  type: "turn-start",
  timestamp: string,
  phase: "new-turn" | "intermediate-step",
}
```

### TypeScript types

```typescript
import type {
  TrajectoryEvent,
  StepEvent,
  UserStepEvent,
  AgentStepEvent,
  ApprovalEvent,
  MetadataEvent,
  CompactionEvent,
  ErrorEvent,
  InterruptEvent,
  TurnStartEvent,
} from "@ai-sdk-tool/headless";
```

> Note: pre-ATIF examples that used standalone `user`, `assistant`, `tool_call`, and `tool_result` event types are obsolete. Tool results are now carried in `step.observation.results`, and `session_id` appears only in the initial `metadata` event.

---

## Advanced Usage

### Custom event sink (write to file)

```typescript
import { runHeadless, type TrajectoryEvent } from "@ai-sdk-tool/headless";
import { appendFileSync } from "node:fs";

const logFile = "output.jsonl";

await runHeadless({
  agent,
  sessionId,
  messageHistory,
  modelId,
  emitEvent: (event: TrajectoryEvent) => {
    appendFileSync(logFile, JSON.stringify(event) + "\n");
  },
});
```

### With TODO continuation

Keeps the agent running until all TODO items are complete.

```typescript
import { TodoContinuation } from "@ai-sdk-tool/harness";
import { runHeadless } from "@ai-sdk-tool/headless";

const todo = new TodoContinuation({
  todoDir: ".sisyphus/todos",
  sessionId,
});

await runHeadless({
  agent,
  sessionId,
  messageHistory,
  modelId,
  onTodoReminder: () => todo.getReminder(),
});
```

### Iteration safety cap

```typescript
await runHeadless({
  agent,
  sessionId,
  messageHistory,
  modelId,
  maxIterations: 50,  // emits an error event and stops after 50 iterations
});
```

### Parsing JSONL output

```bash
# Run headless and filter only agent step events
pnpm run headless -- "Fix the bug" | grep '"type":"step"' | jq 'select(.source == "agent") | .message'
```

```typescript
// Parse events from a JSONL event log
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { TrajectoryEvent } from "@ai-sdk-tool/headless";

const rl = createInterface({ input: createReadStream("output.jsonl") });

for await (const line of rl) {
  const event = JSON.parse(line) as TrajectoryEvent;
  if (event.type === "step" && event.source === "agent") {
    console.log("Assistant:", event.message);
  }
}
```

## License

MIT
