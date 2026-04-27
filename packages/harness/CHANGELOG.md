# @ai-sdk-tool/harness

## 1.3.3

### Patch Changes

- a6b8a5f: `FileSnapshotStore` now takes a top-level directory (e.g. `.plugsuits`, `.minimal-agent`) and manages its internal layout itself: session snapshots land in `<root>/sessions/*.jsonl`. The public `rootDir` / `sessionsDir` getters expose the resolved paths for consumers that want to co-locate related files (e.g. session memory).

  When the root directory lives inside a git worktree (detected by a sibling `.git` marker, directory or file), the store appends the top-level directory to that worktree's `.gitignore` if not already listed. The update is concurrency-safe: an exclusive `.gitignore.lock` (via `openSync(path, "wx")`) serializes writers, and the content swap is atomic (temp-file + rename). Stale locks older than 30s are reclaimed so a crashed writer can't wedge the next caller. The file's existing line-ending convention is preserved (LF or CRLF), and the helper refuses to write to any ancestor `.gitignore` that is not at a verified worktree root — so it cannot accidentally modify a parent repo's or a user's home-level ignore file. Disable with `new FileSnapshotStore(dir, { autoGitignore: false })`.

  Env var migrations (no backward compatibility):

  - `minimal-agent`: `SESSION_DIR` → `MINIMAL_AGENT_DIR` (default `.minimal-agent`)
  - `tgbot`: `SESSION_DIR` → `TGBOT_DIR` (default `<tmpdir>/tgbot`)

  CEA now constructs its store with `.plugsuits` as the top-level directory and derives its session-memory path from `store.sessionsDir`.

  The previously-undocumented `getFilePath` fallback for unencoded session filenames has been removed; session files always live at `<sessionsDir>/<encodeSessionId(sessionId)>.jsonl`.

- c40f690: Verify the runtime subpath in a real Cloudflare Worker bundle and keep optional Node-only MCP and skills modules out of edge bundles unless those features are configured.
- 54125d0: Keep the runtime subpath importable in edge runtimes by removing unconditional Node-only dotenv, skills, MCP, and crypto imports from the core runtime graph.

## 1.3.2

### Fixes

- `env.ts`: moved `.env` file discovery side-effects out of module top level into `loadDotEnvFilesIfAvailable()` helper. The module now loads safely in edge runtimes (Cloudflare Workers, Vercel Edge) without `node:fs` access. Callers that relied on the automatic `.env` loading must explicitly call `loadDotEnvFilesIfAvailable()` from their Node.js entry point.

## 1.3.1

### Patch Changes

- e937dc7: Keep env-file loading compatible with Node 18, preserve URL validation for shared AI endpoints, and align CEA's default context limit with the shared AI configuration.
- 5bb3997: Update direct and transitive dependency resolutions across the monorepo, including AI SDK packages, tooling, TypeScript, and runtime adapters. Raise the declared Node.js support floor to 22.19.0 to match upgraded runtime dependencies such as undici 8.
- 8b1919c: Persist user-level agent preferences across sessions (e.g. `/translate`, `/reasoning-mode`, `/tool-fallback` in CEA; `/reasoning` in minimal-agent) so toggles set in the TUI survive process restarts.

  - Harness: new generic `PreferencesStore<T>` abstraction with `FilePreferencesStore` (single atomic JSON document), `InMemoryPreferencesStore`, `LayeredPreferencesStore` (configurable merge + write layer), and `shallowMergePreferences` helper. Exposed from the package root and a new `@ai-sdk-tool/harness/preferences` subpath. Intentionally separate from `SnapshotStore` because preferences are app/user-scoped while snapshots are session-scoped.
  - Harness: new one-line helper `createLayeredPreferences({ appName, validate })` that returns `{ store, userStore, workspaceStore, patch, paths }` backed by `~/.${appName}/settings.json` (user layer) and `./.${appName}/settings.json` (workspace layer, write target). `patch(partial)` handles the load-merge-save flow on the workspace layer so consumers don't have to reimplement it. Fully customizable paths, merge strategy, and validator — but the common case is now a single call.
  - Harness: new `createTogglePreferenceCommand` and `createEnumPreferenceCommand` factories that collapse the typical "parse args → validate → mutate runtime → persist" slash-command boilerplate into a declarative config object. Typed `field: keyof T` ensures persistence goes to the right preference key. Supports aliases, custom truthy/falsy words, custom parser, custom validator, and custom enabled/disabled messages.
  - CEA: `createUserPreferencesStore()` now delegates to `createLayeredPreferences` and also exposes the full harness bundle alongside the existing public fields. `/translate` is migrated to `createTogglePreferenceCommand`; the CEA-local `createToggleCommand` factory is deleted as dead code. `/translate` now awaits persistence (previously fire-and-forget), so the command response confirms the disk write.
  - CEA: `/reasoning-mode` and `/tool-fallback` continue to use the shared `preferences-persistence` singleton for now (they have domain-specific selectable-modes logic that is not a good fit for the generic factory yet). `configurePreferencesPersistence` now accepts an optional `bundle` argument so future migrations can reuse the harness factories.
  - CEA startup: persisted preferences are applied to `AgentManager` before CLI flags. Explicit CLI flags (`--no-translate`, `--reasoning-mode on`, `--tool-fallback`, `--toolcall-mode`) still win for the current process but no longer overwrite the persisted file — they are one-shot overrides only. `resolveSharedConfig` now accepts `rawArgs` so callers can distinguish explicit flags from defaults.
  - minimal-agent: gains a `/reasoning <on|off>` slash command that toggles `providerOptions.openai.reasoningEffort` via the `onBeforeTurn` hook and persists the value through `createLayeredPreferences`. The command definition is a single 10-line factory call thanks to `createTogglePreferenceCommand`. Header subtitle shows the live reasoning state. Preferences are stored at `~/.minimal-agent/settings.json` and `./.minimal-agent/settings.json` (separate from CEA so the two agents' defaults don't collide).

- 8b1919c: Harden the user-preferences persistence layer against failure and concurrency, discovered during manual QA of PR #119 and flagged by the Oracle reviewer.

  - Harness: `FilePreferencesStore.clear()` now deletes the file with `rmSync` instead of writing `"{}"`. Previously `clear()` left an empty `{}` on disk, and un-validated stores would return `{}` from `load()` instead of `null`, breaking the contract shared with `InMemoryPreferencesStore`. Consumers using a validator were unaffected in practice because empty objects already validated to `null`.
  - Harness: `createLayeredPreferences().patch()` now serializes calls through a promise queue. Previous implementation was a plain read-modify-write, so two concurrent `patch()` calls could both read the same stale workspace JSON and one update would be silently dropped. Concurrency tests cover both different-field and same-field writes.
  - Harness: `createTogglePreferenceCommand` and `createEnumPreferenceCommand` now **persist before mutating runtime**. If disk persistence fails, the runtime state is never touched and the command returns `{ success: false, message: "Failed to persist …" }`. If the runtime `set()` throws after a successful persist, the disk write is rolled back to the previous value. This eliminates the class of "disk and runtime disagree" bugs across all factory-backed commands.
  - CEA: `patchWorkspacePreferences` now queues writes per-store via a `WeakMap`-keyed promise chain, matching the harness bundle semantics. This protects the shim path used by `/reasoning-mode` and `/tool-fallback` from the same lost-update race that previously affected the factory path.
  - CEA: `applyPersistedPreferencesToAgentManager` and `applySharedConfigToAgentManager` extracted from `main.ts` into `packages/cea/src/entrypoints/preferences-startup.ts`. Now pure functions taking the agent manager and store as arguments, so startup wiring is testable in isolation. Existing `main.ts` call sites updated to pass dependencies explicitly.
  - CEA: minimal-agent gains `vitest` devDep, `test` script, `vitest.config.ts`, and excludes `*.test.ts` / `vitest.config.ts` from the TypeScript build output. `citty` was a dead devDependency — removed.
  - Tests added:
    - Harness `preferences-store.test.ts`: `clear()` ⇒ `load()` null, `clear()` removes file on disk, `clear()` no-op on missing file, cross-instance restart, three concurrent-patch scenarios (different fields, same field, queue recovery after failure).
    - Harness `preference-commands.test.ts`: persist-first contract — toggle + enum commands do NOT mutate runtime when persistence fails, toggle command rolls back disk when runtime set throws, toggle command returns success only when BOTH disk and runtime succeed.
    - CEA `user-preferences.test.ts`: concurrent `patchWorkspacePreferences` preserves all fields, same-field is last-writer-wins, save errors bubble to caller.
    - CEA `preferences-persistence.test.ts` (new): singleton lifecycle, custom `onError` handler fires on save failure, concurrent `persistPreferencePatch` preserves all fields.
    - CEA `reasoning-mode.test.ts` (new): 7 tests covering status report, valid transitions, invalid mode rejection, persistence, sibling field preservation, no-op "already using", graceful behavior without persistence configured.
    - CEA `tool-fallback.test.ts` (new): 7 tests in the same shape.
    - CEA `preferences-startup.test.ts` (new): integration tests for `applyPersistedPreferencesToAgentManager` and `applySharedConfigToAgentManager` covering all three fields, CLI-vs-persisted precedence, and the invariant that CLI flags never write to the store.
    - minimal-agent `preferences.test.ts` (new): 7 tests covering path expectations, schema validation, round-trip, and the `/reasoning` onBeforeTurn integration (toggle → closure mutation → providerOptions change).
  - Test counts:
    - Harness: 673 → 699 (+26)
    - CEA: 526 → 563 (+37)
    - minimal-agent: 0 → 7 (+7)
    - Total workspace: 1283 → 1353 (+70)

- 496ffdb: Surface the "prompt processing" state that previously looked frozen, and fix follow-up correctness gaps found during post-implementation review.

  - Harness: new `LoopHooks.onStreamStart` / `onFirstStreamPart` hooks wrap the `agent.stream()` call site so consumers driving turns through `runAgentLoop` can react to the prompt-processing latency gap. `onFirstStreamPart` receives the current stream part as its first argument (`TextStreamPart<ToolSet>`) so consumers can inspect `part.type` to filter framing chunks (`start`, `text-start`, …) from visible content. `TextStreamPart` is re-exported from the harness root for convenience. Docstring clarifies that the TUI has its own independent `onStreamStart` on `AgentTUIConfig`.
  - TUI: shows a `Processing...` loader during turn preparation and transitions to `Working...` once the LLM request is in flight. The startup token probe is now non-blocking (fire-and-forget) so the editor accepts input immediately; the context-usage footer starts from the estimated count and quietly upgrades to the real value. During a blocking compaction the foreground loader temporarily switches to `Compacting...` and restores the previous label when the block ends, so users see the actual reason for a long wait. `text-start` stream parts are now treated as visible, clearing the streaming loader as soon as the assistant view mounts (no more empty-view flicker).
  - Headless: emits a `turn-start` lifecycle annotation and a matching `onStreamStart` callback before each LLM request; the event is dropped from `trajectory.json` (transient UX signal, no `step_id`) so persisted consumers see identical output. The event fires exactly once per logical turn — overflow and no-output retries no longer re-emit it. New tests cover normal ordering, `new-turn` vs `intermediate-step` phases, retry single-emission, and non-persistence in `trajectory.json`.
  - Headless: the persisted `schema_version` is corrected from the internal `ATIF-v1.6` label to the actual current Harbor spec version `ATIF-v1.4` (<https://www.harborframework.com/docs/agents/trajectory-format>). Documentation across `packages/headless/AGENTS.md`, `packages/headless/README.md`, and `packages/cea/benchmark/AGENTS.md` now separates the internal JSONL streaming protocol (which carries lifecycle annotations such as `approval`, `compaction`, `interrupt`, `turn-start`) from the ATIF-v1.4 trajectory that `TrajectoryCollector` writes to disk.
  - Headless: `StepMetrics` gains the remaining ATIF-v1.4 optional fields (`logprobs`, `prompt_token_ids`, `completion_token_ids`) and `TrajectoryJson.final_metrics` now aggregates `total_cost_usd`. `TrajectoryJson.extra` is typed as a closed record of exactly the three ATIF persistence buckets (`approval_events`, `compaction_events`, `interrupt_events`); new lifecycle types must extend the interface explicitly so the Harbor persistence contract stays type-enforced.
  - CEA: the `--atif` CLI help text and the benchmark pipeline now reference ATIF-v1.4 (matching the corrected `schema_version`). The bundled `packages/cea/benchmark/test_trajectory.py` validator now calls Harbor's official `TrajectoryValidator` when `harbor` is importable and falls back to a stricter local shape check otherwise; it enforces per-step metric shapes and rejects `bool` values where ATIF requires a real number.
  - Addressed PR review feedback:
    - `turn-start` and `onStreamStart` now fire strictly after `agent.stream()` successfully returns, so stream-creation failures no longer produce a false "stream started" signal (reported by Gemini, Codex, and Cubic reviewers).
    - The background startup usage probe is serialized against per-turn probes by a generation token; a stale startup probe can no longer overwrite newer usage data and skew context-pressure metrics.
    - The blocking-compaction spinner swap only stashes the original foreground label on first entry and only restores it when the foreground loader is still live, eliminating both the "Compacting..." wording sticking after unblock and the "Processing..." spinner resurrecting after the first stream part arrived.
    - Restored the post-`onSetup` `updateHeader()` call that was accidentally dropped when the startup probe became non-blocking, so any header/footer state that `onSetup` initialises renders immediately instead of waiting for the first probe to resolve.
    - The bundled Python ATIF validator (`test_trajectory.py`) no longer accepts `bool` values where ATIF v1.4 requires a real number — `isinstance(True, int)` is `True` in Python, so the old check let invalid metric payloads slip through. Added `_is_real_number` / `_is_real_int` helpers that exclude `bool`.
    - Observer hooks (`onStreamStart`, `onFirstStreamPart`) no longer abort a valid stream when the callback throws. Errors are logged via `console.error` and swallowed in the harness loop, headless runner, and TUI session loop, with the contract documented on `LoopHooks`.
    - Repaired a regression where `LoopHooks.onToolCall` had silently dropped out of the public `LoopHooks` interface while still being destructured inside `runAgentLoop`. The field is restored to its original signature; consumers that already relied on it are unaffected, and the destructuring now type-checks again.
    - Corrected the `LoopHooks.onFirstStreamPart` signature as a pre-adoption fix (Cubic P2): the previous `(context) => void` shape promised in its docstring that consumers could filter on part type, but the callback never received the part. The signature now passes `(part: TextStreamPart<ToolSet>, context)` so consumers can actually inspect `part.type`. Zero existing consumers were found across the monorepo (the hook was introduced earlier in this PR), so this is a type-only correction with no runtime migration. New regression tests in `loop.test.ts` cover single-fire semantics, per-iteration firing, empty-stream skip, and observer-error isolation.
  - Pinned the ATIF v1.4 compliance contract in-source: `trajectory-collector.ts`, `TrajectoryJson`, `AtifStep`, `TrajectoryEvent`, `collectTrajectoryEvent`, and `runHeadless` now carry module/interface-level JSDoc spelling out the Harbor spec version, the allowed `steps[*].source` values, the `extra.*` persistence rule, and the stream-vs-snapshot boundary. `packages/headless/AGENTS.md` gains an "ATIF v1.4 COMPLIANCE" section listing the same invariants, and the `atif-events.test.ts` suite now declares itself as the executable compliance contract. These are docs-only, but they turn future spec drifts into obvious code-review red flags instead of silent regressions.
  - Review cycle 1 follow-ups (Oracle + Gemini + Codex + Cubic + CodeRabbit):
    - Guarded `TrajectoryCollector.writeTo` against persisting an invalid zero-step trajectory (Harbor's own validator rejects `steps: []`). The method now returns `boolean` — `true` when a file was written, `false` when the write was intentionally skipped to keep `trajectory.json` ATIF-v1.4 compliant.
    - Moved the TUI `showLoader("Processing...")` call inside the stream-turn `try/finally` so a thrown `prepareMessages` (or `onBeforeTurn`/usage probe/compaction check) no longer leaves the spinner stuck on screen.
    - Tightened the startup usage-probe guard: in addition to the generation token, `measureUsageIfAvailable` now captures `messageHistory.getRevision()` at call time and drops its result when the history has mutated mid-probe, preventing stale empty-message usage from overwriting per-turn measurements.
    - Narrowed `TrajectoryJson.extra` to the three canonical lifecycle buckets (`approval_events`, `compaction_events`, `interrupt_events`) by dropping the `Record<string, unknown>` intersection. New lifecycle types must now extend the interface explicitly, keeping the ATIF persistence contract type-enforced.
    - Hardened the Python validator: `_is_real_number` now rejects `NaN`, `Infinity`, and `-Infinity` (all of which `json.loads` will happily produce from non-strict JSON) via an explicit `math.isfinite` check.
    - Corrected documentation drift across `packages/headless/AGENTS.md`, `packages/headless/README.md`, `packages/headless/src/types.ts`, `packages/headless/src/trajectory-collector.ts`, and the root `AGENTS.md`: `approval`/`compaction`/`interrupt` are persisted under `trajectory.extra.*`, not JSONL-only; only `turn-start` and `error` are transient.
    - Regression test added for the `writeTo` zero-step guard: `does not write an invalid zero-step trajectory when the stream fails before any step`.
  - Review cycle 2 follow-ups (Oracle re-audit):
    - Headless `measureUsageIfAvailable` now carries the same generation + revision guards the TUI already had. A slow background probe that resolves after a compaction or a newer per-turn probe no longer overwrites fresh usage data.
    - ATIF v1.4 step source contract aligned across code, Python validator, and benchmark docs: `user`, `agent`, and `system` are all permitted (Harbor v1.2+). Previous divergence between `AtifStep.source` and `test_trajectory.py`'s `valid_sources = {user, agent}` is resolved.
    - Root `README.md` headless event list now includes `turn-start` and points at Harbor's ATIF-v1.4 schema for the persisted trajectory.

## 1.3.0

### Minor Changes

- a714664: Add `defineAgent`, `createAgentRuntime`, and `AgentSession` runtime layer to harness. Add `runAgentSessionTUI` and `runAgentSessionHeadless` session adapter helpers to tui and headless. Remove deprecated `SessionStore`, `CheckpointHistory.fromSession()`, and legacy token field aliases (`completionTokens`, `promptTokens`).

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
