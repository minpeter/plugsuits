# @ai-sdk-tool/harness

A lightweight, model-agnostic agent harness built on the [Vercel AI SDK](https://sdk.vercel.ai). Provides the core loop, message history management, session lifecycle, skills loading, TODO continuation, command registry, and tool orchestration primitives for building AI agents.

## Installation

```bash
pnpm add @ai-sdk-tool/harness
# or
npm install @ai-sdk-tool/harness
```

**Peer dependencies:**

```bash
pnpm add ai zod
```

## Quick Start

```typescript
import { createAgent, runAgentLoop, MessageHistory } from "@ai-sdk-tool/harness";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { tool } from "ai";

// 1. Create an agent with a model and tools
const agent = createAgent({
  model: openai("gpt-4o"),
  instructions: "You are a helpful assistant.",
  tools: {
    get_time: tool({
      description: "Get the current time",
      parameters: z.object({}),
      execute: async () => new Date().toISOString(),
    }),
  },
});

// 2. Run the agent loop
const result = await runAgentLoop({
  agent,
  messages: [{ role: "user", content: "What time is it?" }],
  onToolCall: (call, ctx) => {
    console.log(`[${ctx.iteration}] Tool call: ${call.toolName}`);
  },
  onStepComplete: (step) => {
    console.log(`Step ${step.iteration} done (${step.finishReason})`);
  },
});

console.log(`Finished after ${result.iterations} iterations`);
```

## API Reference

### `createAgent(config)`

Creates an `Agent` instance that wraps a Vercel AI SDK `streamText` call.

```typescript
import { createAgent } from "@ai-sdk-tool/harness";

const agent = createAgent({
  model,                        // LanguageModel — required
  instructions,                 // string | (() => Promise<string>) — system prompt
  tools,                        // ToolSet — tool definitions
  maxStepsPerTurn,              // number — max tool-call steps per stream (default: 1)
  experimental_repairToolCall,  // repair callback for malformed tool calls
});
```

**Returns:** `Agent` — an object with `config` and `stream(opts)` method.

---

### `runAgentLoop(options)`

Runs the agent in a loop until a stop condition is met or `maxIterations` is reached.

```typescript
import { runAgentLoop } from "@ai-sdk-tool/harness";

const result = await runAgentLoop({
  agent,           // Agent — required
  messages,        // ModelMessage[] — initial conversation history
  maxIterations,   // number — max loop iterations (default: unlimited)
  abortSignal,     // AbortSignal — for cancellation

  // Hooks
  shouldContinue,  // (finishReason, context) => boolean — custom continuation logic
  onToolCall,      // (call, context) => void | Promise<void>
  onStepComplete,  // (step) => void | Promise<void>
  onError,         // (error, context) => void | Promise<void>
});
```

**Returns:** `RunAgentLoopResult`

```typescript
interface RunAgentLoopResult {
  messages: ModelMessage[];       // Full conversation history after loop
  iterations: number;             // Number of iterations completed
  finishReason: AgentFinishReason; // Final finish reason
}
```

---

### `MessageHistory`

Manages conversation history with configurable limits, compaction, and automatic cleanup of invalid message sequences.

```typescript
import { MessageHistory } from "@ai-sdk-tool/harness";

const history = new MessageHistory({
  maxMessages: 50,          // Max messages to keep (default: unlimited)
  compactionConfig: {       // Optional: summarize old messages instead of dropping
    summarize: async (messages) => "Summary of earlier conversation...",
    triggerRatio: 0.8,      // Compact when 80% full
  },
});

// Add messages
history.addUserMessage("Hello!");
history.addModelMessages(responseMessages);

// Get messages for the next API call
const messages = history.toModelMessages();

// Enforce the limit (called automatically, but can be called manually)
history.enforceLimit();
```

**Key behaviors:**
- `enforceLimit()` trims the history to `maxMessages`, always preserving the first message (system context)
- After trimming, orphaned `tool` role messages (without a preceding `assistant` tool-call) are automatically removed to prevent provider errors
- `performCompaction()` summarizes old messages using the provided `summarize` function before trimming

---

### `SessionManager`

Manages a UUID-based session ID lifecycle. Useful for stamping events and file paths with a consistent identifier.

```typescript
import { SessionManager } from "@ai-sdk-tool/harness";

const session = new SessionManager("my-agent"); // optional prefix, default: "session"

const sessionId = session.initialize(); // => "my-agent-<uuid>"
console.log(session.getId());           // => "my-agent-<uuid>"
console.log(session.isActive());        // => true
```

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `initialize()` | `string` | Generates and stores a new session ID |
| `getId()` | `string` | Returns the current session ID; throws if not initialized |
| `isActive()` | `boolean` | Returns `true` if `initialize()` has been called |

---

### `SkillsEngine`

Discovers and loads skills from up to five directories: bundled, global skills, global commands, project skills, and project commands.

```typescript
import { SkillsEngine, type SkillsConfig } from "@ai-sdk-tool/harness";

const config: SkillsConfig = {
  bundledDir: "./skills",           // Bundled skills shipped with the agent
  globalSkillsDir: "~/.agent/skills",
  globalCommandsDir: "~/.agent/commands",
  projectSkillsDir: ".agent/skills",
  projectCommandsDir: ".agent/commands",
};

const engine = new SkillsEngine(config);
const skills = await engine.loadSkills(); // SkillInfo[]

// Get content of a specific skill
const content = await engine.getSkillContent("my-skill");
```

**`SkillInfo` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique skill identifier |
| `name` | `string` | Display name |
| `description` | `string` | Short description for autocomplete |
| `path` | `string` | Absolute path to the skill file |
| `format` | `"legacy" \| "v2" \| "command"` | Skill file format |
| `source` | `"bundled" \| "global" \| "project" \| "global-command" \| "project-command"` | Where the skill was found |
| `argumentHint` | `string?` | Hint shown in autocomplete for skills that take arguments |

---

### `TodoContinuation`

Reads a todo JSON file and generates reminder messages for incomplete tasks. Used with `runHeadless` to keep the agent running until all TODOs are done.

```typescript
import { TodoContinuation, type TodoConfig } from "@ai-sdk-tool/harness";

const todo = new TodoContinuation({
  todoDir: ".sisyphus/todos",   // Directory containing todo JSON files
  sessionId: "session-abc123",  // Used to locate the correct todo file
  promptTemplate: (todos) => `You have ${todos.length} tasks remaining.`,
  userMessageTemplate: (todos) => `Continue with: ${todos[0].content}`,
});

const reminder = await todo.getReminder();
// => { hasReminder: true, message: "..." }
// or { hasReminder: false, message: null }
```

**`TodoItem` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique task ID |
| `content` | `string` | Task description |
| `status` | `"pending" \| "in_progress" \| "completed" \| "cancelled"` | Current status |
| `priority` | `"high" \| "medium" \| "low"` | Task priority |
| `description` | `string?` | Optional longer description |

---

### Command Registry

A global registry for slash commands. Commands are registered once and available to both TUI and headless runtimes.

```typescript
import {
  registerCommand,
  executeCommand,
  getCommands,
  isCommand,
  parseCommand,
  configureCommandRegistry,
  createHelpCommand,
  resolveRegisteredCommandName,
  isSkillCommandResult,
} from "@ai-sdk-tool/harness";

// Register a command
registerCommand({
  name: "model",
  description: "Switch the active model",
  aliases: ["m"],
  execute: async ({ args }) => {
    const newModel = args[0];
    return { success: true, message: `Switched to ${newModel}` };
  },
});

// Check if input is a command
if (isCommand("/model gpt-4o")) {
  const result = await executeCommand("/model gpt-4o");
  console.log(result?.message);
}

// Configure skill loading for /skill-name commands
configureCommandRegistry({
  skillLoader: async (name) => {
    const content = await loadSkillFile(name);
    return content ? { content, id: name } : null;
  },
});
```

**Functions:**

| Function | Description |
|----------|-------------|
| `registerCommand(command)` | Adds a command to the global registry |
| `executeCommand(input)` | Parses and executes a command string |
| `getCommands()` | Returns the full `Map<string, Command>` |
| `isCommand(input)` | Returns `true` if input starts with `/` |
| `parseCommand(input)` | Parses `"/name arg1 arg2"` into `{ name, args }` |
| `configureCommandRegistry(config)` | Sets the skill loader for skill-based commands |
| `createHelpCommand(getCommands)` | Creates a `/help` command listing all registered commands |
| `resolveRegisteredCommandName(name)` | Resolves an alias to its canonical command name |
| `isSkillCommandResult(result)` | Type guard for `SkillCommandResult` |

---

### `buildMiddlewareChain(config)`

Builds a middleware chain for wrapping language model calls. Useful for logging, caching, or modifying requests/responses.

```typescript
import { buildMiddlewareChain, type MiddlewareConfig } from "@ai-sdk-tool/harness";
import { wrapLanguageModel } from "ai";

const middlewares = buildMiddlewareChain({
  middlewares: [loggingMiddleware, cachingMiddleware],
});

const wrappedModel = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: middlewares[0], // or compose them
});
```

---

### `createAgentPaths(options)`

Creates a consistent set of filesystem paths for agent configuration and TODO storage.

```typescript
import { createAgentPaths } from "@ai-sdk-tool/harness";

const paths = createAgentPaths({
  configDirName: ".my-agent",
  todoDirName: "todos",
  todoBaseDir: "/tmp",  // optional, defaults to os.tmpdir()
});

// paths.configDir => ".my-agent"
// paths.todoDir   => "/tmp/todos"
```

---

### `shouldContinueManualToolLoop(finishReason, context)`

The default continuation predicate used by `runAgentLoop`. Returns `true` when `finishReason` is `"tool-calls"`.

```typescript
import { shouldContinueManualToolLoop } from "@ai-sdk-tool/harness";

// Use as custom shouldContinue with additional logic
const result = await runAgentLoop({
  agent,
  messages,
  shouldContinue: (reason, ctx) => {
    if (ctx.iteration >= 10) return false; // Custom limit
    return shouldContinueManualToolLoop(reason, ctx);
  },
});
```

---

### `normalizeFinishReason(reason)`

Normalizes provider-specific finish reason strings to a canonical `AgentFinishReason`.

```typescript
import { normalizeFinishReason } from "@ai-sdk-tool/harness";

const normalized = normalizeFinishReason("tool_calls"); // => "tool-calls"
```

---

### Compaction prompts

Built-in summarization prompts for `MessageHistory` compaction.

```typescript
import {
  createModelSummarizer,
  DEFAULT_SUMMARIZATION_PROMPT,
  ITERATIVE_SUMMARIZATION_PROMPT,
} from "@ai-sdk-tool/harness";

const summarize = createModelSummarizer({
  model: openai("gpt-4o-mini"),
  prompt: DEFAULT_SUMMARIZATION_PROMPT,
});

const history = new MessageHistory({
  maxMessages: 100,
  compactionConfig: { triggerRatio: 0.8, summarize },
});
```

---

## Types

```typescript
import type {
  Agent,
  AgentConfig,
  AgentStreamOptions,
  AgentStreamResult,
  AgentFinishReason,
  LoopContinueContext,
  LoopStepInfo,
  LoopHooks,
  RunAgentLoopOptions,
  RunAgentLoopResult,
  // Re-exported from Vercel AI SDK:
  LanguageModel,
  ModelMessage,
  Tool,
  ToolCallPart,
  ToolSet,
  // MessageHistory types:
  CompactionConfig,
  CompactionSummary,
  Message,
  MessageHistoryOptions,
  // Session:
  // (SessionManager is a class, not a type)
  // Skills:
  SkillInfo,
  SkillsConfig,
  // TODO:
  TodoConfig,
  TodoItem,
  // Commands:
  Command,
  CommandContext,
  CommandRegistryConfig,
  CommandResult,
  SkillCommandResult,
  // Middleware:
  MiddlewareConfig,
  // Paths:
  AgentPaths,
  AgentPathsOptions,
  // Tool pruning:
  PruneResult,
  PruningConfig,
} from "@ai-sdk-tool/harness";
```

## Advanced Usage

### Custom tool-call repair

```typescript
const agent = createAgent({
  model,
  experimental_repairToolCall: async ({ toolCall, error, messages, system }) => {
    // Return repaired tool call arguments, or null to skip repair
    console.warn(`Repairing tool call: ${toolCall.toolName}`, error);
    return null;
  },
});
```

### Compacting long conversations

```typescript
const history = new MessageHistory({
  maxMessages: 100,
  compactionConfig: {
    triggerRatio: 0.8, // Compact when 80 messages reached
    summarize: async (messages) => {
      // Use your model to summarize
      const summary = await generateSummary(messages);
      return summary;
    },
  },
});
```

### Abort signal for cancellation

```typescript
const controller = new AbortController();

// Cancel after 30 seconds
setTimeout(() => controller.abort(), 30_000);

const result = await runAgentLoop({
  agent,
  messages,
  abortSignal: controller.signal,
});
```

### Full session setup

```typescript
import {
  createAgent,
  MessageHistory,
  SessionManager,
  SkillsEngine,
  TodoContinuation,
  registerCommand,
  createHelpCommand,
  getCommands,
  createAgentPaths,
} from "@ai-sdk-tool/harness";

const paths = createAgentPaths({
  configDirName: ".my-agent",
  todoDirName: "todos",
});

const session = new SessionManager("my-agent");
const sessionId = session.initialize();

const history = new MessageHistory({ maxMessages: 200 });

const skillsEngine = new SkillsEngine({
  bundledDir: "./skills",
  projectSkillsDir: ".my-agent/skills",
});
const skills = await skillsEngine.loadSkills();

const todo = new TodoContinuation({
  todoDir: paths.todoDir,
  sessionId,
});

registerCommand(createHelpCommand(getCommands));

const agent = createAgent({ model, instructions: "..." });
```

## License

MIT
