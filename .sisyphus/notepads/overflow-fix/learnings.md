# Learnings

## 2026-03-24 Session Start
- harness package has 177 tests passing (15 test files)
- checkpoint-history.ts is 1019 lines
- `handleContextOverflow()` at L624-672 throws error on exhaustion instead of returning {success:false}
- `didRecoverySucceed()` at L829-844 checks `tokensAfter >= tokensBefore` (broken — should check budget)
- `tryPruneRecovery()` at L846-871 never calls `pruneToolOutputs()` — it's a complete no-op
- `tryCompactionRecovery()` at L873-908 calls `compact({auto:true})` which bypasses aggressive flag handling
- `tryTruncateRecovery()` at L910-949 skips summary messages so can never reduce when only summaries remain
- No snapshot/rollback mechanism exists

## Key Types/Imports
- `pruneToolOutputs` from `./tool-pruning` — takes `(messages, config)`, returns `PruneResult` with `.messages` array
- `estimateTokens` from `./token-utils` — used for token counting
- `extractMessageText` from `./message-text` — extracts text from message
- `calculateCompactionSplitIndex` from `./compaction-planner` — determines where to split for compaction

## Active messages
- `getActiveMessages()` at L753 — returns messages from summaryMessageId onwards
- messages array is `this.messages`, summary checkpoint at `this.summaryMessageId`
- Revision tracked at `this.revision`

## Test File
- Append to: `packages/harness/src/checkpoint-history.test.ts`
- Test setup uses `createTestHistory()` helper typically
- Use `estimateTokens()` for token count assertions

## 2026-03-25 Overflow recovery update
- `tryTruncateRecovery()` now has 3-stage behavior: remove non-summary, then remove summary, then keep a single final message.
- Nuclear stage now returns terminal `{ success: false, error: "context window too small for remaining content" }` when one-message state is still over budget.
- `handleContextOverflow()` now differentiates non-terminal skip (`null`) from terminal truncate failure (`{ success: false }`) via truthy return handling.
