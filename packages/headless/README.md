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
const agent = createAgent({
  model: openai("gpt-4o"),
  instructions: "You are a helpful assistant.",
});

// Register signal handlers before any async work
registerSignalHandlers({
  onCleanup: () => {},
  onFatalCleanup: (exitCode) => process.exit(exitCode),
});

// Add the initial user message
messageHistory.addUserMessage("Fix the type error in src/index.ts");

// Run the agent — emits JSONL events to stdout
await runHeadless({
  sessionId,
  stream: (messages) => agent.stream({ messages }),
  messageHistory,
  getModelId: () => "gpt-4o",
});
```

**Example output (ATIF-v1.6):**

```jsonl
{"type":"metadata","timestamp":"2026-04-03T10:00:00.000Z","session_id":"ses-abc123","agent":{"name":"code-editing-agent","version":"1.0.0","model_name":"gpt-4o"}}
{"type":"step","step_id":1,"timestamp":"2026-04-03T10:00:00.000Z","source":"user","message":"Fix the type error in src/index.ts"}
{"type":"step","step_id":2,"timestamp":"2026-04-03T10:00:01.000Z","source":"agent","message":"I'll inspect the file.","model_name":"gpt-4o","tool_calls":[{"tool_call_id":"call_1","function_name":"read_file","arguments":{"path":"src/index.ts"}}],"metrics":{"prompt_tokens":520,"completion_tokens":80}}
{"type":"step","step_id":3,"timestamp":"2026-04-03T10:00:02.000Z","source":"system","observation":{"results":[{"source_call_id":"call_1","content":"{\"stdout\":\"...file contents...\"}"}]}}
{"type":"step","step_id":4,"timestamp":"2026-04-03T10:00:03.000Z","source":"agent","message":"I found the issue and fixed it.","model_name":"gpt-4o","metrics":{"prompt_tokens":410,"completion_tokens":65}}
```

## API Reference

### `runHeadless(config)`

Runs the agent loop, emitting JSONL events for each turn. Continues looping while the agent makes tool calls. Optionally continues after the main loop if there are incomplete TODO items.

```typescript
import { runHeadless } from "@ai-sdk-tool/headless";

await runHeadless({
  sessionId,       // string — becomes metadata.session_id
  stream,          // (messages: unknown[]) => Promise<AgentStreamResult>
  messageHistory,  // CheckpointHistory from @ai-sdk-tool/harness
  getModelId,      // () => string — current model ID for metadata and agent steps
  maxIterations,   // optional number — safety cap on loop iterations
  emitEvent,       // optional (event: TrajectoryEvent) => void — defaults to stdout JSONL
  onTodoReminder,  // optional () => Promise<{ hasReminder, message }> — TODO continuation
});
```

**Config fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionId` | `string` | yes | Unique ID emitted once as `metadata.session_id` |
| `stream` | `(messages) => Promise<AgentStreamResult>` | yes | Agent stream function |
| `messageHistory` | `CheckpointHistory` | yes | Conversation history — read and written during the loop |
| `getModelId` | `() => string` | yes | Returns the current model ID for metadata and `step` events |
| `maxIterations` | `number` | no | Total iteration budget across the entire headless run, including TODO reminder turns; emits an `error` event and stops if exceeded |
| `emitEvent` | `(event) => void` | no | Custom event sink; defaults to `console.log(JSON.stringify(event))` |
| `onTodoReminder` | `() => Promise<{ hasReminder, message }>` | no | Called after the main loop; if `hasReminder` is true, sends `message` as a user turn and continues |

---

### `emitEvent(event)`

Writes a single `TrajectoryEvent` as a JSONL line to stdout. This is the default event sink used by `runHeadless`.

```typescript
import { emitEvent } from "@ai-sdk-tool/headless";

emitEvent({
  type: "user",
  sessionId: "session-abc123",
  timestamp: new Date().toISOString(),
  content: "Hello!",
});
// stdout: {"type":"user","sessionId":"session-abc123","timestamp":"...","content":"Hello!"}
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

Headless output now follows the **ATIF-v1.6** protocol documented in `packages/headless/AGENTS.md`.

### Event overview

| Type | Source | Description |
|------|--------|-------------|
| `metadata` | system | Emitted once at start with `session_id` and agent info |
| `step` | `user` | A user message step |
| `step` | `agent` | An agent response, including text, reasoning, tool calls, and optional observations |
| `step` | `system` | A system step, typically observations detached from the agent message |
| `compaction` | system | Lifecycle event for history compaction |
| `error` | system | Fatal error or iteration-limit event |

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
  source: "user" | "agent" | "system",
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

### `error`

```typescript
{
  type: "error",
  timestamp: string,
  error: string,
}
```

### TypeScript types

```typescript
import type {
  TrajectoryEvent,
  StepEvent,
  UserStepEvent,
  AgentStepEvent,
  SystemStepEvent,
  MetadataEvent,
  CompactionEvent,
  ErrorEvent,
} from "@ai-sdk-tool/headless";
```

> Note: pre-ATIF examples that used standalone `user`, `assistant`, `tool_call`, and `tool_result` event types are obsolete. Tool results are now carried in `step.observation.results`, and `session_id` appears only in the initial `metadata` event.

---

## Advanced Usage

### Custom event sink (write to file)

```typescript
import { runHeadless, type TrajectoryEvent } from "@ai-sdk-tool/headless";
import { appendFileSync } from "node:fs";

const logFile = "trajectory.jsonl";

await runHeadless({
  sessionId,
  stream,
  messageHistory,
  getModelId,
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
  sessionId,
  stream,
  messageHistory,
  getModelId,
  onTodoReminder: () => todo.getReminder(),
});
```

### Iteration safety cap

```typescript
await runHeadless({
  sessionId,
  stream,
  messageHistory,
  getModelId,
  maxIterations: 50,  // emits an error event and stops after 50 iterations
});
```

### Parsing JSONL output

```bash
# Run headless and filter only agent step events
pnpm run headless -- "Fix the bug" | grep '"type":"step"' | jq 'select(.source == "agent") | .message'
```

```typescript
// Parse events from a trajectory file
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { TrajectoryEvent } from "@ai-sdk-tool/headless";

const rl = createInterface({ input: createReadStream("trajectory.jsonl") });

for await (const line of rl) {
  const event = JSON.parse(line) as TrajectoryEvent;
  if (event.type === "step" && event.source === "agent") {
    console.log("Assistant:", event.message);
  }
}
```

## License

MIT
