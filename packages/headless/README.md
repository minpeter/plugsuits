# @ai-sdk-tool/headless

A non-interactive, JSONL event-streaming runtime for agent sessions. Instead of rendering to a terminal, it writes structured events to stdout — one JSON object per line. Suitable for CI/CD pipelines, benchmarks, and any programmatic consumer that needs a machine-readable transcript.

## Installation

```bash
bun add @ai-sdk-tool/headless
# or
npm install @ai-sdk-tool/headless
```

**Peer dependencies:**

```bash
bun add @ai-sdk-tool/harness ai
```

## Quick Start

```typescript
import { createAgent, MessageHistory, SessionManager } from "@ai-sdk-tool/harness";
import { runHeadless, registerSignalHandlers } from "@ai-sdk-tool/headless";
import { openai } from "@ai-sdk/openai";

const session = new SessionManager();
const sessionId = session.initialize();

const messageHistory = new MessageHistory();
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

**Example output:**

```jsonl
{"type":"user","sessionId":"session-abc123","timestamp":"2026-03-09T10:00:00.000Z","content":"Fix the type error in src/index.ts"}
{"type":"tool_call","sessionId":"session-abc123","timestamp":"2026-03-09T10:00:01.000Z","model":"gpt-4o","tool_name":"read_file","tool_call_id":"call_1","tool_input":{"path":"src/index.ts"}}
{"type":"tool_result","sessionId":"session-abc123","timestamp":"2026-03-09T10:00:01.500Z","tool_call_id":"call_1","output":"...file contents..."}
{"type":"assistant","sessionId":"session-abc123","timestamp":"2026-03-09T10:00:03.000Z","model":"gpt-4o","content":"I found the issue and fixed it."}
```

## API Reference

### `runHeadless(config)`

Runs the agent loop, emitting JSONL events for each turn. Continues looping while the agent makes tool calls. Optionally continues after the main loop if there are incomplete TODO items.

```typescript
import { runHeadless } from "@ai-sdk-tool/headless";

await runHeadless({
  sessionId,       // string — unique session ID stamped on every event
  stream,          // (messages: unknown[]) => Promise<AgentStreamResult>
  messageHistory,  // MessageHistory from @ai-sdk-tool/harness
  getModelId,      // () => string — current model ID for event metadata
  maxIterations,   // optional number — safety cap on loop iterations
  emitEvent,       // optional (event: TrajectoryEvent) => void — defaults to stdout JSONL
  onTodoReminder,  // optional () => Promise<{ hasReminder, message }> — TODO continuation
});
```

**Config fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionId` | `string` | yes | Unique ID stamped on every emitted event |
| `stream` | `(messages) => Promise<AgentStreamResult>` | yes | Agent stream function |
| `messageHistory` | `MessageHistory` | yes | Conversation history — read and written during the loop |
| `getModelId` | `() => string` | yes | Returns the current model ID for `tool_call` and `assistant` events |
| `maxIterations` | `number` | no | Max loop iterations; emits an `error` event and stops if exceeded |
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

All events share `sessionId: string` and `timestamp: string` (ISO 8601).

### `user`

A user message sent to the agent.

```typescript
{
  type: "user",
  sessionId: string,
  timestamp: string,
  content: string,
}
```

### `assistant`

A completed assistant text response.

```typescript
{
  type: "assistant",
  sessionId: string,
  timestamp: string,
  content: string,
  model: string,
  reasoning_content?: string,  // present when the model emits reasoning tokens
}
```

### `tool_call`

A tool invocation by the agent.

```typescript
{
  type: "tool_call",
  sessionId: string,
  timestamp: string,
  model: string,
  tool_name: string,
  tool_call_id: string,
  tool_input: Record<string, unknown>,
  reasoning_content?: string,
}
```

### `tool_result`

The result of a tool call.

```typescript
{
  type: "tool_result",
  sessionId: string,
  timestamp: string,
  tool_call_id: string,
  output: string,
  error?: string,       // present if the tool threw
  exit_code?: number,   // present for shell execution tools
}
```

### `error`

A fatal error or iteration limit reached.

```typescript
{
  type: "error",
  sessionId: string,
  timestamp: string,
  error: string,
}
```

### TypeScript types

```typescript
import type {
  TrajectoryEvent,
  UserEvent,
  AssistantEvent,
  ToolCallEvent,
  ToolResultEvent,
  ErrorEvent,
  BaseEvent,
} from "@ai-sdk-tool/headless";
```

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
# Run headless and filter only assistant events
bun run headless -- --prompt "Fix the bug" | grep '"type":"assistant"' | jq .content
```

```typescript
// Parse events from a trajectory file
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { TrajectoryEvent } from "@ai-sdk-tool/headless";

const rl = createInterface({ input: createReadStream("trajectory.jsonl") });

for await (const line of rl) {
  const event = JSON.parse(line) as TrajectoryEvent;
  if (event.type === "assistant") {
    console.log("Assistant:", event.content);
  }
}
```

## License

MIT
