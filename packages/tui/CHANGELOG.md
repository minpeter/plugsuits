# @ai-sdk-tool/tui

## 3.1.1

### Patch Changes

- 5bb3997: Update direct and transitive dependency resolutions across the monorepo, including AI SDK packages, tooling, TypeScript, and runtime adapters. Raise the declared Node.js support floor to 22.19.0 to match upgraded runtime dependencies such as undici 8.
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

- f523de9: Bump outdated dependencies to their latest releases: `@ai-sdk-tool/parser` 4.1.21, `vitest` 4.1.5, and `@mariozechner/pi-tui` 0.68.1. Align the `@ai-sdk-tool/tui` peer range for `@mariozechner/pi-tui` to `^0.68.1` and update `createAliasAwareAutocompleteProvider` to the new async autocomplete API (`getSuggestions` now returns a `Promise<AutocompleteSuggestions | null>` and accepts the `{ signal, force? }` options object).
- 88b7197: Reserve a fixed two-line slot above the prompt editor so the foreground spinner no longer causes layout shift when it mounts or unmounts, and drop the redundant header bottom spacer that duplicated that gap.
- 2a29da7: Route all agent pending states (`Thinking...` / `Working...` / `Executing...`) through the same foreground status spinner slot above the prompt editor, unify their visual language via a shared primitive, and lock every surfaced regression behind fixture tests.

  - TUI: new shared primitive `pending-spinner.ts` exposing `PENDING_SPINNER_FRAMES` (braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`), `PENDING_SPINNER_INTERVAL_MS` (80ms), `stylePendingIndicator(frame, message)` (cyan frame + dim message), and `createSpinnerTicker(onFrame, options?)`. `StatusSpinner`, `FooterStatusBar`, and CEA's internal `pi-tui-stream-renderer.ts` tool view all route through it so any future palette / cadence / glyph change lands in one place. Previously tool-pending blocks rendered plain ASCII `- \ | /` frames with no color.
  - TUI: `PiTuiStreamState` gains optional `onReasoningStart` / `onReasoningEnd` callbacks. `handleReasoningStart` fires `onReasoningStart`; a new `handleReasoningEnd` handler fires `onReasoningEnd` (previously `reasoning-end` was silently dropped via `IGNORE_PART_TYPES`). `isVisibleStreamPart` now treats `reasoning-start` / `reasoning-delta` / `reasoning-end` as non-visible, so the first-visible-part spinner clear only fires on real text / tool output.
  - TUI: the foreground spinner label swaps to `Thinking...` for reasoning spans and restores the caller-provided base label (`Working...`) on `reasoning-end`. When a visible part arrives before the second reasoning span of a turn (post tool-call), `foregroundStatus` has already been cleared, so `onReasoningStart` revives the spinner via `showLoader("Thinking...")` and `onReasoningEnd` tears down only the spinner it revived — ordinary flows that kept the base loader alive restore that label unchanged.
  - TUI: `PiTuiStreamState` gains optional `onToolPendingStart` / `onToolPendingEnd` callbacks. `onToolPendingStart` fires from `handleToolCall`; `onToolPendingEnd` fires from `handleToolResult`, `handleToolError`, `handleToolOutputDenied`, and `handleToolApprovalRequest` (approval pauses execution so the spinner must release). `onToolPendingEnd` runs unconditionally — independent of `showToolResults` — so the spinner is always restored even when the tool result itself is not rendered visually. `renderAgentStream` wires these into the same foreground spinner slot (`showLoader("Executing...")` with revive-if-null semantics and a counter so parallel tool calls only restore the base label once every pending call resolves). `Executing...` sits directly above the prompt, identical in placement to `Thinking...`.
  - TUI: overlapping reasoning / tool lifecycles are handled safely. `onToolPendingEnd` skips restoring the base label when reasoning is currently active (`reasoningRevivedSpinner === true`), so a tool result arriving mid-reasoning does not overwrite the live `Thinking...` label.
  - TUI: `BaseToolCallView` no longer renders any inline pending indicator — the foreground spinner owns the pending affordance. `setPrettyBlock(header, body, options?)` now writes the body text through unchanged regardless of `options.isPending`, so consumers can pass a non-empty body alongside `isPending: true` (e.g. `edit_file`'s live diff preview) and have it remain visible while the tool runs. All of the old pretty-block spinner plumbing (`startPendingSpinner`, `stopPendingSpinner`, `paintPendingBodyFrame`, `pendingSpinnerTicker`, `pendingTemplate`, `lastPendingFrame`, `PENDING_MESSAGE`, `PENDING_MARKER`) is removed.
  - TUI: fix the 2-blank-line gap above the foreground spinner during pretty-block pending state. `ensurePrettyBlockComponents` used to add a standalone `new Spacer(1)` between `readHeader` and `readBody`, which always emitted `[""]` even when `readBody` rendered to `[]` (empty-text short-circuit). Combined with `StatusSpinner.render()`'s own leading `""`, callers saw two blank rows above `Executing...`. The explicit `Spacer(1)` is removed; `BackgroundBody.render()` now prepends its own leading `""` only when the body has content, which preserves the one-blank separator between header and body in non-pending mode and eliminates the stray blank in pending mode. `Executing...` now sits with a single leading blank line, identical to `Thinking...` / `Working...`.
  - CEA: the internal `pi-tui-stream-renderer.ts` pending spinner is kept in sync via the shared primitive. `setPrettyBlock` is simplified to always write the body text through (pending branch deleted); the dead `startPendingSpinner` / `stopPendingSpinner` / `paintPendingFrame` / `TOOL_PENDING_SPINNER_FRAMES` / `TOOL_PENDING_MESSAGE` / `TOOL_PENDING_MARKER` / `SpinnerTicker` state is removed. `renderPendingOutput()` now returns `""` so pretty-rendered tools show the header only while pending (no leftover marker text). The companion `preserves requestRender this-context for pending spinner updates` test is removed (its machinery no longer exists); five other tests that locked in the old in-block `Executing...` painting are inverted to assert the absence of that text.
  - TUI: comprehensive regression fixture tests lock every bug surfaced during this PR:
    - `pending-spinner.test.ts` (new) — `PENDING_SPINNER_FRAMES`, `PENDING_SPINNER_INTERVAL_MS`, the exact `stylePendingIndicator` ANSI byte sequence, `createSpinnerTicker` lifecycle (initial frame emission, 80ms cadence, frame wraparound, `stop()` idempotency, `emitInitialFrame: false`, custom `intervalMs`).
    - `stream-handlers.test.ts` (extended) — parametric proof that all three reasoning parts are invisible under any flag combination (the invariant that keeps `Thinking...` alive); `IGNORE_PART_TYPES` does not contain `reasoning-start` / `reasoning-end`; `STREAM_HANDLERS` has a handler for every known part type; reasoning / tool lifecycle callbacks dispatch correctly; parallel-tool-call counter semantics; `onToolPendingEnd` fires on approval-gate transition.
    - `tool-call-view.test.ts` (extended) — inline `toMatchInlineSnapshot` fixtures for pretty-block pending (header-only, no trailing blank) and non-pending (header / blank / body) render shapes. Assertions that `BaseToolCallView` never emits `Executing` or any braille spinner glyph. Raw fallback trailing-blank-free lock.
    - `spinner-layout.test.ts` (new) — end-to-end layout invariant: tool block + foreground spinner has exactly one blank line between them across raw fallback, pretty-block pending, and pretty-block non-pending modes. Parametric trailing-blank-free assertions across all four rendering modes.

- 003dca1: Polish the TUI area around the prompt so transient status updates and tool-call startup no longer cause avoidable visual jumps.

  - Render the foreground loader through `FooterStatusBar` so `Processing...`, `Working...`, `Executing...`, and `Compacting...` share the footer row with context pressure instead of mounting a standalone status block near the editor.
  - Rename `CommandPreprocessHooks.statusContainer` to `overlayContainer`; CEA and minimal-agent now mount their slash-command selectors in that overlay container while clearing the footer loader first.
  - Make `BaseToolCallView` reserve visible space immediately with a `Preparing tool call…` pending indicator until real tool input arrives, avoiding a zero-height gap at tool-call start.
  - Tighten the `✓ New session started` banner spacing, remove the eager gray `⚡ Interrupted` message in favor of the final red interruption hint, and clear footer status when starting a new session.

## 3.1.0

### Minor Changes

- a714664: Add `defineAgent`, `createAgentRuntime`, and `AgentSession` runtime layer to harness. Add `runAgentSessionTUI` and `runAgentSessionHeadless` session adapter helpers to tui and headless. Remove deprecated `SessionStore`, `CheckpointHistory.fromSession()`, and legacy token field aliases (`completionTokens`, `promptTokens`).

## 3.0.2

### Patch Changes

- 5e0768c: Fix review issues: runAgentLoop message retention, isContextOverflowError call sites, setTimeout leak, CEA token estimation, session history separation, per-thread memory tracking, vi.mock hoisting, AgentError export, and lint cleanup
- Updated dependencies [5e0768c]
  - @ai-sdk-tool/harness@1.2.4

## 3.0.1

### Patch Changes

- 2f62589: Prevent infinite compaction loops in small-context scenarios. Adds a per-turn compaction cap (`maxAcceptedCompactionsPerTurn`, default 10), relaxes the compaction acceptance gate to reject only on `fitsBudget` failures, and introduces opt-in task-aware 2-step compaction (enabled in CEA) that extracts the current user turn's task intent before summarizing to preserve the work context. Turn boundaries are now tracked via `notifyNewUserTurn()` called from TUI and headless runtime.
- Updated dependencies [2f62589]
- Updated dependencies [2f62589]
  - @ai-sdk-tool/harness@1.2.1

## 3.0.0

### Patch Changes

- Updated dependencies [18bfebb]
  - @ai-sdk-tool/harness@1.2.0

## 2.0.1

### Patch Changes

- 9ba8e20: fix: add .js extensions to ESM imports for Node.js compatibility
- Updated dependencies [9ba8e20]
  - @ai-sdk-tool/harness@1.1.1

## 2.0.0

### Major Changes

- 5aaef15: fix: publish @ai-sdk-tool/headless and @ai-sdk-tool/tui to npm

  Initial major release of headless and tui packages to npm registry.
  Republish plugsuits with corrected dependency versions.

## 1.0.0

### Minor Changes

- 5a8b087: feat: decouple shared runtimes and simplify context footer text

  - split the shared harness, terminal UI, and headless runner into reusable workspace packages with expanded session, command, and compaction infrastructure
  - unify the `plugsuits` CLI around the shared runtimes, improve `/compact` behavior, and make file read failures more actionable
  - remove the `Context:` prefix from footer-style context usage displays so the TUI shows a cleaner token summary across agents

- 618d458: refactor: ship the segment-first compaction system across the shared runtimes

  - move harness compaction onto segment-based state and prepared artifacts
  - share compaction orchestration across TUI and headless runtimes
  - guard CEA model calls from empty prepared message lists under tight context budgets

### Patch Changes

- Updated dependencies [badc5c7]
- Updated dependencies [5a8b087]
- Updated dependencies [618d458]
  - @ai-sdk-tool/harness@1.1.0
