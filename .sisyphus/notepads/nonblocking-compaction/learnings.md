# Learnings

## [2026-03-10] Session Start
- Worktree: /Users/minpeter/github.com/minpeter/plugsuits-nonblocking-compaction
- Branch: work/nonblocking-compaction (created from work/harness-cea-decoupling @ db1d0d0)
- Pre-work already committed: speculativeStartRatio, baseMessageIds/baseSummaryIds, non-blocking TUI/headless flow
- Build: passes (bun run build)
- Typecheck: passes (bun run typecheck)
- Tests: 660 pass, 0 fail (from source)

## [2026-03-10] Pre-Work State
- `baseMessageIds` and `baseSummaryIds` already added to PreparedCompaction (stale detection)
- `speculativeStartRatio` already added to CompactionConfig
- TUI agent-tui.ts: blocking UI removed, Escape key added, speculative dedup improved
- Headless runner.ts: turn-boundary compaction apply added
- BUT: estimateTokens still private (Task 1 NOT done)
- BUT: isAtHardContextLimit() NOT implemented (Task 2 NOT done)
- BUT: contextLimitAtCreation NOT in PreparedCompaction (Task 2 NOT done)
- BUT: getMessagesForLLMAsync() still has inline compaction (Task 3 NOT done)

## [2026-03-10] Key File Locations
- message-history.ts: estimateTokens at line 41 (private), getMessagesForLLMAsync at line 1136
- tool-pruning.ts: duplicate estimateTokens at line 10
- harness/src/index.ts: barrel exports (add estimateTokens here)
- agent-tui.ts: waitForSpeculativeCompactionIfNeeded at line ~579, startSpeculativeCompaction at ~600
- runner.ts: runHeadless function, speculative compaction logic

## [2026-03-11] Task 5 — Headless non-blocking compaction
- Headless now mirrors the TUI split: fire-and-forget speculative compaction during normal flow, block only through isAtHardContextLimit(...).
- applyReadySpeculativeCompaction() must inspect applyPreparedCompaction(...).reason; stale results need immediate discard plus one background re-fire.
- processAgentResponse() can use sync getMessagesForLLM() safely once ready speculative work is applied and hard-limit rescue is handled separately.
- Intermediate tool-loop rescue in headless is simpler than TUI: preserve intermediate-step reserve for the hard-limit check, but always prepare rescue compaction with phase "new-turn" for maximum reduction.

## [2026-03-11] Task 4 — Non-blocking compaction in TUI
- TUI now blocks only at hard context limit using `messageHistory.isAtHardContextLimit(...)`; normal turn preparation is non-blocking.
- `prepareMessages(phase)` now runs: apply-ready -> hard-limit rescue if needed -> sync `getMessagesForLLM()` -> fire-and-forget speculative start.
- Extracting pure core helpers (`applyReadySpeculativeCompactionCore`, `blockAtHardContextLimitCore`, `discardAllSpeculativeCompactionJobsCore`) made non-blocking behavior directly unit-testable without full TUI harness.
- Stale prepared compaction handling is safe when checking `applyPreparedCompaction(...).reason`; single stale re-fire (guarded) avoids infinite loops.
- `/clear` (`new-session` action) explicitly discards speculative jobs before clearing message history, preventing stale/background carryover.

## [2026-03-11] Task 5 — Headless mirrors TUI non-blocking compaction
- The headless runner can stay simpler than TUI because it tracks only one speculative job, but stale-at-hard-limit handling still works by re-firing once and consuming that replacement on the second blocking attempt.
- `waitForSpeculativeCompactionIfNeeded()` should short-circuit on `isAtHardContextLimit(estimateTokens(content), { phase: "new-turn" })`; below the hard limit, it must never await speculative work.
- `processAgentResponse()` should use `applyReadySpeculativeCompaction()` + `isAtHardContextLimit(0, { phase })` + sync `getMessagesForLLM()` so normal turns stay fire-and-forget while intermediate tool-loop steps can still block when truly necessary.

## [2026-03-11] Task 4 & 5 Completion

### Task 4 (TUI) — commit b9b34c3
- `blockOnlyIfAtHardContextLimit(userContent)` implemented — only blocks at hard limit
- `prepareMessages(phase)` replaces `prepareMessagesWithCompaction` — sync path with fire-and-forget
- `applyReadySpeculativeCompaction()` now returns `{ applied, stale }` — stale triggers single re-fire
- `discardAllSpeculativeCompactionJobs()` called on new-session (clear)
- `blockAtHardContextLimitCore` helper extracted for reuse
- New test file: `packages/tui/src/agent-tui-compaction.test.ts` (174 lines)

### Task 5 (Headless) — commit 4b2b8b2
- `waitForSpeculativeCompactionIfNeeded` now calls `blockAtHardContextLimit` — hard-limit-only
- `processAgentResponse` uses sync `getMessagesForLLM()` instead of `getMessagesForLLMAsync()`
- `applyReadySpeculativeCompaction()` returns `{ applied, stale }` — stale triggers re-fire
- `blockAtHardContextLimit` helper added — max 2 attempts, warns if still at limit
- `estimateTokens` imported from `@ai-sdk-tool/harness`
- All 7 headless tests pass including new stale-refire test

### Test counts after Wave 2
- 677 pass, 0 fail (source tests)
- typecheck: 5/5 packages pass


## [2026-03-11] Task 6 — Non-blocking compaction integration coverage
- Added 6 cross-component style integration tests in `packages/harness/src/compaction-integration.test.ts` for non-blocking flow: in-flight message survival, stale rejection on contextLimit change, below-threshold no-start, full fire-and-forget turn cycle, hard-limit block/compact/unblock, and rapid-message dedupe guard.
- Updated the legacy-named compaction test away from `getMessagesForLLMAsync()` wording to explicit prepare/apply flow to reflect neutered async behavior.
- Found and fixed a real snapshot race bug: `prepareSpeculativeCompaction()` now captures `baseMessageIds`, `baseSummaryIds`, `contextLimitAtCreation`, and `compactionMaxTokensAtCreation` BEFORE async compaction work; this prevents falsely accepting snapshots that were created before tail appends.
- Verification: source suite `683 pass / 0 fail`, harness suite `158 pass / 0 fail`, targeted integration suite `24 pass / 0 fail`, typecheck `5/5` packages successful.
