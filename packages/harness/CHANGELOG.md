# @ai-sdk-tool/harness

## 1.2.4

### Patch Changes

- 5e0768c: Fix review issues: runAgentLoop message retention, isContextOverflowError call sites, setTimeout leak, CEA token estimation, session history separation, per-thread memory tracking, vi.mock hoisting, AgentError export, and lint cleanup

## 1.2.3

### Patch Changes

- bd8bd8a: Add session lifecycle and formatting APIs:
  - `CheckpointHistory.fromSession()`: async factory that restores sessions from SessionStore without double-persisting messages
  - `CheckpointHistory.resetForSession()`: switch to a new sessionId while preserving compaction/pruning config
  - `SessionStore.deleteSession()`: delete a session's JSONL file from disk
  - `formatTokens()` / `formatContextUsage()`: token count and context usage formatting utilities (moved from consumer packages)

## 1.2.2

### Patch Changes

- 6ce5711: Add MCP (Model Context Protocol) client integration and improve developer experience

  - `createAgent()` now accepts an `mcp` option for automatic MCP tool loading
  - `createAgent()` is now async and returns `Promise<Agent>`
  - `Agent.close()` method added for MCP connection cleanup (no-op when no MCP configured)
  - `MCPOption` supports four forms: `true` (load from `.mcp.json`), `MCPServerConfig[]` (inline servers), `{ config, servers }` (both), or a pre-initialized `MCPManager` instance
  - MCPManager caching with reference counting — same config reuses existing connections
  - Inline server arrays (`MCPServerConfig[]`) now correctly passed to MCPManager
  - `MCPManagerOptions.servers` added for programmatic server injection
  - Minimal agent wired with DuckDuckGo search MCP server

## 1.2.1

### Patch Changes

- 2f62589: Silence unhandled rejections on createAgent stream result promises. When the underlying `streamText()` rejects its internal DelayedPromise fields (for example with `NoOutputGeneratedError` after an empty provider stream), the `totalUsage` promise was never awaited by downstream consumers and caused a process-level `unhandledRejection` crash. The fix attaches no-op rejection handlers to all four promise-returning fields (`finishReason`, `response`, `usage`, `totalUsage`) while returning the original promise instances, so callers still receive rejections normally when they do await them.
- 2f62589: Prevent infinite compaction loops in small-context scenarios. Adds a per-turn compaction cap (`maxAcceptedCompactionsPerTurn`, default 10), relaxes the compaction acceptance gate to reject only on `fitsBudget` failures, and introduces opt-in task-aware 2-step compaction (enabled in CEA) that extracts the current user turn's task intent before summarizing to preserve the work context. Turn boundaries are now tracked via `notifyNewUserTurn()` called from TUI and headless runtime.

## 1.2.0

### Minor Changes

- 18bfebb: Migrate token usage naming from `promptTokens`/`completionTokens` to `inputTokens`/`outputTokens` to align with Vercel AI SDK v6.

  Fix model-agnostic compaction bug: prevent `totalTokens` from being misattributed as `promptTokens` when the provider omits prompt token counts. Invalidate stale `actualUsage` after message changes and compaction.

  Remove compact-test model entry — use `COMPACTION_DEBUG=1 CONTEXT_LIMIT_OVERRIDE=<N>` to simulate small context windows on any model.

## 1.1.1

### Patch Changes

- 9ba8e20: fix: add .js extensions to ESM imports for Node.js compatibility

## 1.1.0

### Minor Changes

- badc5c7: feat: iterative compaction — pass previous summary to summarizeFn for context-aware updates

  - Extended `summarizeFn` signature with optional `previousSummary` parameter (backwards compatible)
  - `performCompaction()` now passes combined previous summaries to `summarizeFn`
  - After compaction, previous summaries are merged into a single entry (always 1 summary)
  - `defaultSummarizeFn` includes previous context in structured format when available
  - `createModelSummarizer` uses `ITERATIVE_SUMMARIZATION_PROMPT` when updating existing summaries
  - Added `ITERATIVE_SUMMARIZATION_PROMPT` export for customization
  - Added `iterativePrompt` option to `ModelSummarizerOptions`

- 5a8b087: feat: decouple shared runtimes and simplify context footer text

  - split the shared harness, terminal UI, and headless runner into reusable workspace packages with expanded session, command, and compaction infrastructure
  - unify the `plugsuits` CLI around the shared runtimes, improve `/compact` behavior, and make file read failures more actionable
  - remove the `Context:` prefix from footer-style context usage displays so the TUI shows a cleaner token summary across agents

- 618d458: refactor: ship the segment-first compaction system across the shared runtimes

  - move harness compaction onto segment-based state and prepared artifacts
  - share compaction orchestration across TUI and headless runtimes
  - guard CEA model calls from empty prepared message lists under tight context budgets

## 0.3.1

### Patch Changes

- 2f41927: Remove hardcoded MANUAL_TOOL_LOOP_MAX_STEPS=200 cap and default maxIterations to Infinity. The loop now runs until the model returns a stop finish reason, an abort signal fires, or a custom shouldContinue callback returns false. Also fix shouldContinue context inconsistency where iteration was stale (pre-increment) while messages were already updated.

## 0.3.0

### Minor Changes

- 902ded6: Improve compaction reliability, token estimation, and tool-pair handling

  - Remove fire-and-forget compaction race condition — use explicit `compact()` or prepared compaction via `prepareSpeculativeCompaction()` / `applyPreparedCompaction()`
  - Add CJK token estimation (Korean/Chinese/Japanese: ~1.5 chars/token vs Latin ~4 chars/token)
  - Fix splitIndex edge cases for single-message and boundary scenarios
  - Preserve tool-call/tool-result pairs during compaction
  - Improve default summarizer with conversation turn grouping
  - Add `needsCompaction()` for synchronous threshold checking
  - Keep `getMessagesForLLMAsync()` as a deprecated compatibility wrapper around `getMessagesForLLM()`
  - Add E2E test suite for real model compaction validation

## 0.2.1

### Patch Changes

- 1f1f77d: docs(harness): add README and JSDoc to public API

  Adds a comprehensive README for the `@ai-sdk-tool/harness` package covering
  installation, quick start, full API reference, and advanced usage examples.
  Adds JSDoc comments to `agent.ts`, `loop.ts`, and `types.ts` for IDE
  discoverability and generated documentation.

  Closes #38

- cabecaf: fix(harness): remove orphaned tool_result messages after enforceLimit and performCompaction

  Adds `ensureNoOrphanedToolResults()` private method to `MessageHistory` that removes
  `tool` role messages that lack a preceding `assistant` message with tool-call parts.
  This prevents providers from rejecting invalid message sequences when the history is
  trimmed at a tool-call/tool-result boundary.

  Closes #39

## 0.2.0

### Minor Changes

- b519c2a: feat: add incremental context compaction feature

  - Automatic and manual compaction when token limits are approached
  - Turn splitting support for preserving conversation continuity
  - File operation tracking (read/edit) in summaries
  - Advanced token estimation (image, tool calls)
  - Configurable via CompactionConfig interface
  - 47 comprehensive tests included

## 0.1.1

### Patch Changes

- 62b4261: Set up Changesets-based release automation for the monorepo.
  Add the `pss` CLI alias for `plugsuits` and switch internal harness dependency to a publish-safe semver range.
