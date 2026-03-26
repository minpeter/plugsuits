# Learnings — compaction-validation

## [2026-03-11] Plan Initialized

### Key Architecture Facts
- `performCompaction()` is in `packages/harness/src/message-history.ts` around line 1243-1384
- `summaryEntry` is created around line 1363 — validation MUST go AFTER this, BEFORE line 1368 (state mutation)
- `CompactionSummary` interface has `tokensBefore` and `summaryTokens` fields (line 258-269)
- `this.summaries` array contains old summaries — their `summaryTokens` must be included in `totalTokensReplaced`
- `PreparedCompaction` interface is at line 271-285
- `prepareSpeculativeCompaction()` is at line 885-930
- `applyPreparedCompaction()` is at line 932-986
- `CompactOptions` type is at line 387-395
- `compact()` method is at line 1079-1110

### Iterative Compaction Formula
- WRONG: `summaryTokens >= tokensBefore` (ignores old summary being replaced)
- CORRECT: `summaryTokens >= tokensBefore + sum(this.summaries[].summaryTokens)`
- This prevents false positive rejection when old summary tokens are being replaced

### Key Constraints
- `compact()` return type MUST stay `Promise<boolean>` — 30+ call sites
- Use `lastCompactionRejected` getter pattern instead of changing return type
- Do NOT change auto-compaction trigger logic
- Do NOT add retry-on-rejection logic
- Rejection on `>=` (inclusive) — no-reduction compaction is also rejected

### TUI/Headless Patterns
- `applyReadySpeculativeCompactionCore` in `packages/tui/src/agent-tui.ts:384-424`
- Headless `applyReadySpeculativeCompaction` in `packages/headless/src/runner.ts:54-78`
- Background status mechanism used for compaction progress — use same for rejection notification

### Test Files
- `packages/harness/src/compaction-integration.test.ts` — main compaction tests
- `packages/tui/src/agent-tui-compaction.test.ts` — TUI compaction tests
- `packages/cea/src/commands/compact.test.ts` — /compact command tests
- `packages/harness/src/message-history.test.ts` — message history unit tests

## [2026-03-11] Token-increase rejection implemented

- Added `MessageHistory._lastCompactionRejected` and public `lastCompactionRejected` getter to report non-beneficial compaction attempts without changing `compact()` return type.
- In `performCompaction()`, reset rejection flag at method start and reject when `summaryTokens >= (tokensBefore + oldSummaryTokens)` before mutating `summaries/messages`.
- Added integration coverage for larger/equal/smaller summaries, iterative replace math (old summary + replaced messages), and prune-success + compaction-rejection mixed path.

## [2026-03-11] Speculative prepared rejection propagation

- `PreparedCompaction` now includes `rejected: boolean` so speculative jobs can carry compaction rejection state from clone to apply phase.
- `prepareSpeculativeCompaction()` populates `rejected` from `clone.lastCompactionRejected` immediately after `clone.compact(...)`.
- `applyPreparedCompaction()` now returns `reason: "rejected"` before `didChange` checks, preserving stale checks first and treating rejected prepared jobs as non-applied.
- TUI `applyReadySpeculativeCompactionCore()` treats `"rejected"` as noop-like: discard job only, no `onStale` callback, no `discardAllJobs`.

## [2026-03-11] Aggressive compaction mode (all-message summary)

- Added per-call `aggressive?: boolean` to `CompactOptions` only; `CompactionConfig` remains unchanged.
- `compact()` now threads `aggressive` into `performCompaction(...)` without changing return type.
- Aggressive split logic compacts all messages by returning `splitIndex = messages.length` when `messages.length > 1`, skipping `adjustSplitIndexForToolPairs` entirely.
- Aggressive path sets `messagesToKeep = []` and `firstKeptMessageId = "end"`, then reuses existing safety checks (including token-increase rejection).
- Single-message aggressive compaction still returns `false` (insufficient content to summarize).
- `ensureNoOrphanedToolResults()` safely handles empty `messages` after aggressive compaction.

## [2026-03-11] Final QA verification

- Targeted QA scenarios passed for oversized-summary rejection, iterative acceptance, prune+reject interaction, speculative rejected propagation, aggressive all-message compaction, trailing tool-message compaction, TUI rejected-no-refire handling, and `/compact` aggressive/rejection messaging.
- Workspace validation also passed with `bun run typecheck`, `bun run test`, and `bun run build` from repo root.
