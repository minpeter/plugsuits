# Issues — compaction-validation

## [2026-03-11] Pre-existing LSP Errors (NOT our problem)

These errors exist BEFORE our changes — do not fix them unless they block our work:

1. `packages/tui/src/agent-tui.ts:71-74,150` — "Use a more explicit class property instead of a parameter property" (biome lint)
2. `packages/harness/src/compaction-e2e.test.ts:222` — `Property 'at' does not exist on type 'Message[]'` (tsconfig lib target)
3. `packages/harness/src/message-history.test.ts:1189` — Same `.at()` issue
4. `packages/harness/src/message-history.test.ts:1055-1056` — "Forbidden non-null assertion" (biome lint)

These are pre-existing and should NOT be introduced by our changes.

## [2026-03-11] F2 code quality review findings

1. `packages/harness/src/message-history.ts:1405` — iterative compaction undercounts actual token savings. Rejection correctly compares against `tokensBefore + oldSummaryTokens`, but `adjustActualUsageAfterReduction(summaryEntry.tokensBefore - summaryEntry.summaryTokens)` ignores the removed old summary tokens. This can leave `actualUsage.totalTokens` overstated after an accepted replace-summary compaction and can skew later hard-limit/speculative decisions.
2. `packages/tui/src/agent-tui.ts:1233` — `/compact` shows a loader before command execution, but the loader is only cleared on the success path after `executeLocalCommand/executeCommand`. If command execution throws, `processInput()` catches the error and never calls `clearStatus()`, leaving a stuck foreground spinner.

## [2026-03-11] F2 automated check snapshot

- `bun run build` ✅
- `bun run typecheck` ✅
- `bun run test` ✅ (700 pass / 0 fail)
- `bun run check` ❌ due workspace issues outside the reviewed compaction files:
  - `packages/cea/src/agent.ts:198`
  - `packages/cea/src/entrypoints/cli.ts:101`
  - `packages/cea/src/tools/utils/safety-utils.ts:416,1020`
