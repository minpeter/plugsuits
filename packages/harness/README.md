# @ai-sdk-tool/harness

A lightweight, model-agnostic agent harness built on the [Vercel AI SDK](https://sdk.vercel.ai). Provides the core loop, message history management, and tool orchestration primitives for building AI agents.

## Installation

```bash
bun add @ai-sdk-tool/harness
# or
npm install @ai-sdk-tool/harness
```

**Peer dependencies:**

```bash
bun add ai zod
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
  maxIterations,   // number — max loop iterations (default: MANUAL_TOOL_LOOP_MAX_STEPS = 50)
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

### `shouldContinueManualToolLoop(finishReason, context)`

The default continuation predicate used by `runAgentLoop`. Returns `true` when `finishReason` is `"tool-calls"` or `"unknown"`.

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

## License

MIT
