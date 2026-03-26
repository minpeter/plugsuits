# Learnings — legacy-cleanup

## 2026-03-24 Session Start

### Baseline State
- 817 total tests passing (288 harness + 512 CEA + 9 headless + 8 TUI)
- pre-existing LSP errors: loop.test.ts:56-57 (AI SDK mock type mismatch), compaction-e2e.test.ts:222 (.at() lib target), session-store.test.ts:5 (module not found), session-store.ts:86 (continue)
- These are NOT our problem to fix — ignore them

### Key Files
- AgentTUIMessageHistory interface: packages/tui/src/agent-tui.ts:353-395 — STRUCTURAL CONTRACT
- message-history.ts: 1982 lines — TO BE DELETED in T4
- compaction-orchestrator.ts:8 — still imports PreparedCompaction from message-history.ts
- All 12+ missing methods come from MessageHistory — port behavior 1:1, NO new features

### Critical Patterns
- ActualTokenUsage in compaction-types.ts: MAY differ from message-history.ts version (updatedAt field)
- computeSpeculativeStartRatio: exported from message-history.ts, needs to move to compaction-policy.ts
- PreparedCompaction/PreparedCompactionSegment: in message-history.ts:429-453, compaction-orchestrator needs it

### Guardrails (from Metis)
- NO prepareSpeculativeCompaction / applyPreparedCompaction on CheckpointHistory
- NO getSegments / getSummaries / CompactionSegment port
- NO new methods beyond what consumers actually call
- EVERY commit must pass pnpm run typecheck && pnpm test

## 2026-03-24 Token tracking port (CheckpointHistory)

- `CheckpointHistory` now has `clear`, `updateActualUsage`, `getActualUsage`, `getContextUsage` to match token-tracking consumer expectations.
- `getContextUsage` must return a non-null object even when `contextLimit` is unset (`limit=0`, `percentage=0`, `remaining=0`) to satisfy TUI contract usage.
- `clear()` must reset in-memory state only (`messages`, `summaryMessageId`, `actualUsage`) and increment revision.
- `ActualTokenUsage` in `compaction-types.ts` needed `updatedAt?: number` for timestamped usage snapshots.

## 2026-03-24 Context-limit + compaction controls (CheckpointHistory)

- `AgentTUIMessageHistory` structural conformance requires `getRecommendedMaxOutputTokens` and `isAtHardContextLimit` in addition to existing token APIs.
- `CheckpointHistory` needs mutable config fields (`compactionConfig`, `pruningConfig`) to support runtime `updateCompaction` / `updatePruning` merges.
- Delegating threshold math to `compaction-policy.ts` keeps behavior aligned across history implementations and prevents duplicated formulas.
- Speculative compaction trigger must account for `maxTokens` even when `contextLimit` is larger; otherwise orchestrator speculative lifecycle tests can fail.
