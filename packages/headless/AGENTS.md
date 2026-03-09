# HEADLESS PACKAGE — AGENT KNOWLEDGE BASE

Package: `@ai-sdk-tool/headless`
Source: `packages/headless/src/`

## OVERVIEW

This package provides a non-interactive, JSONL event-streaming runtime for agent sessions. Instead of rendering to a terminal, it writes structured events to stdout — one JSON object per line. This makes it suitable for CI/CD pipelines, benchmarks, and any programmatic consumer that needs a machine-readable transcript.

The package depends on `@ai-sdk-tool/harness` for `MessageHistory`, `AgentStreamResult`, and `shouldContinueManualToolLoop`. The agent itself is passed in as a config parameter.

## JSONL EVENT PROTOCOL

Every event is a JSON object on its own line. All events share a `sessionId` and `timestamp` field.

### Event types

| Type | Fields | Description |
|------|--------|-------------|
| `user` | `content: string` | A user message sent to the agent |
| `assistant` | `content: string`, `model: string`, `reasoning_content?: string` | A completed assistant response |
| `tool_call` | `tool_name: string`, `tool_call_id: string`, `tool_input: object`, `model: string`, `reasoning_content?: string` | A tool invocation |
| `tool_result` | `tool_call_id: string`, `output: string`, `error?: string`, `exit_code?: number` | The result of a tool call |
| `error` | `error: string` | A fatal or iteration-limit error |

### Example output

```jsonl
{"type":"user","sessionId":"session-abc123","timestamp":"2026-03-09T10:00:00.000Z","content":"Fix the type error in src/index.ts"}
{"type":"tool_call","sessionId":"session-abc123","timestamp":"2026-03-09T10:00:01.000Z","model":"gpt-4o","tool_name":"read_file","tool_call_id":"call_1","tool_input":{"path":"src/index.ts"}}
{"type":"tool_result","sessionId":"session-abc123","timestamp":"2026-03-09T10:00:01.500Z","tool_call_id":"call_1","output":"...file contents..."}
{"type":"assistant","sessionId":"session-abc123","timestamp":"2026-03-09T10:00:03.000Z","model":"gpt-4o","content":"I found the issue and fixed it."}
```

## KEY EXPORTS

### `runHeadless(config: HeadlessRunnerConfig): Promise<void>`

The main entrypoint. Runs the agent loop, emitting JSONL events for each turn. Optionally continues after the main loop if there are incomplete TODO items.

```typescript
import { runHeadless } from "@ai-sdk-tool/headless";

await runHeadless({
  sessionId,       // string — unique session identifier
  stream,          // (messages: unknown[]) => Promise<AgentStreamResult>
  messageHistory,  // MessageHistory from @ai-sdk-tool/harness
  getModelId,      // () => string — current model ID for event metadata
  maxIterations,   // number — optional safety cap on loop iterations
  emitEvent,       // (event: TrajectoryEvent) => void — optional, defaults to stdout JSONL
  onTodoReminder,  // optional: () => Promise<{ hasReminder, message }> — for TODO continuation
});
```

**Config fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionId` | `string` | yes | Unique ID stamped on every event |
| `stream` | `(messages) => Promise<AgentStreamResult>` | yes | Agent stream function |
| `messageHistory` | `MessageHistory` | yes | Conversation history instance |
| `getModelId` | `() => string` | yes | Returns current model ID |
| `maxIterations` | `number` | no | Max loop iterations before emitting an error event |
| `emitEvent` | `(event) => void` | no | Custom event sink; defaults to `console.log(JSON.stringify(event))` |
| `onTodoReminder` | `() => Promise<{ hasReminder, message }>` | no | Hook for TODO continuation after main loop |

### `emitEvent(event: TrajectoryEvent): void`

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

### `registerSignalHandlers(config: SignalHandlerConfig): void`

Registers process signal handlers for graceful shutdown. Handles `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, `uncaughtException`, and `unhandledRejection`.

```typescript
import { registerSignalHandlers } from "@ai-sdk-tool/headless";

registerSignalHandlers({
  onCleanup: () => {
    // Called on process exit — flush buffers, write final state
  },
  onFatalCleanup: (exitCode) => {
    // Called on signals — must call process.exit(exitCode)
    process.exit(exitCode);
  },
});
```

**Exit codes:** `SIGINT` → 0, `SIGTERM` → 143, `SIGHUP` → 129, `SIGQUIT` → 131, uncaught errors → 1.

### Event types

All event types are exported for use in custom consumers:

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

## FILE MAP

| File | Exports | Role |
|------|---------|------|
| `runner.ts` | `runHeadless`, `HeadlessRunnerConfig` | Main agent loop with JSONL emission and TODO continuation |
| `emit.ts` | `emitEvent` | Default stdout JSONL event sink |
| `signals.ts` | `registerSignalHandlers`, `SignalHandlerConfig` | Process signal lifecycle management |
| `stream-processor.ts` | `processStream` | Processes one stream turn, emitting events per part |
| `types.ts` | `TrajectoryEvent`, `UserEvent`, `AssistantEvent`, `ToolCallEvent`, `ToolResultEvent`, `ErrorEvent`, `BaseEvent` | JSONL event type definitions |

## USAGE PATTERNS

### Minimal headless run

```typescript
import { createAgent, MessageHistory, SessionManager } from "@ai-sdk-tool/harness";
import { runHeadless, registerSignalHandlers } from "@ai-sdk-tool/headless";
import { openai } from "@ai-sdk/openai";

const session = new SessionManager();
const sessionId = session.initialize();
const messageHistory = new MessageHistory();
const agent = createAgent({ model: openai("gpt-4o"), instructions: "..." });

registerSignalHandlers({
  onCleanup: () => {},
  onFatalCleanup: (code) => process.exit(code),
});

messageHistory.addUserMessage("Fix the type error in src/index.ts");

await runHeadless({
  sessionId,
  stream: (messages) => agent.stream({ messages }),
  messageHistory,
  getModelId: () => "gpt-4o",
});
```

### Custom event sink (e.g., write to file)

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

```typescript
import { TodoContinuation } from "@ai-sdk-tool/harness";
import { runHeadless } from "@ai-sdk-tool/headless";

const todo = new TodoContinuation({ todoDir: ".sisyphus/todos", sessionId });

await runHeadless({
  sessionId,
  stream,
  messageHistory,
  getModelId,
  onTodoReminder: () => todo.getReminder(),
});
```

## CONVENTIONS

- This package must not import from `@ai-sdk-tool/cea` or `@ai-sdk-tool/tui`. Dependency direction: `cea` depends on `headless`, not the reverse.
- Every event emitted must include `sessionId` and `timestamp`. Never emit partial events.
- `registerSignalHandlers` uses `process.once` — calling it twice for the same signal is a bug. Call it once at startup.
- `onFatalCleanup` **must** call `process.exit()` — it is typed as `never` to enforce this.
- Do not change event type names or field names without updating trajectory conversion rules in `packages/cea/benchmark/harbor_agent.py`.

## ANTI-PATTERNS

- Emitting events outside of `runHeadless` or `emitEvent` — consumers expect a single ordered stream.
- Swallowing errors silently — always emit an `error` event before exiting on failure.
- Using `console.log` for non-event output in headless mode — it corrupts the JSONL stream. Use `console.error` for diagnostics.
- Registering signal handlers after the agent loop starts — register them before any async work.
