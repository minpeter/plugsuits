# Issues & Gotchas

## 2026-03-24 Session Start

### Pre-existing LSP errors (NOT our concern)
- `loop.test.ts:56-57` — Type errors in mock AsyncGenerator for test
- `compaction-e2e.test.ts:222` — `.at()` not in target lib

### Key Pain Points in Current System (from analysis)
1. Summary injected as system context (not user role)
2. compaction after segments model may lose original messages
3. No persistence across sessions

### Momus Blocking Issues (already fixed in plan)
1. ~~CEA runtime wiring missing~~ → Task 15 now covers main.ts:174, agent.ts:402-428
2. ~~Invalid source references~~ → Corrected to actual line numbers
3. ~~Weak QA scenarios~~ → Tasks 15-17 now have concrete executable QA

### Gotchas to Remember
- `extractMessageText` in `tool-pruning.ts` is a DUPLICATE — Task 3 extracts both to token-utils.ts
- `DEFAULT_COMPACTION_USER_PROMPT` is already handoff-quality — preserve content
- `compaction-e2e.test.ts` has pre-existing .at() error — don't break further

## 2026-03-24 Task T4 Gotcha

- `compaction-planner.ts` had a concrete `CheckpointMessage` signature that broke `MessageHistory` build (`Message` vs `CheckpointMessage` shape mismatch). Restoring generic typing on `calculateCompactionSplitIndex` resolved cross-module compatibility.

## 2026-03-24 Task T14 follow-up gotcha

- Headless stale-refire test timeout was caused by orchestrator overload parsing: `blockAtHardLimit(history, ...)` ignored legacy history objects when they did not satisfy `isHistoryLike`.
- Symptom: second headless stream started before deferred speculative prep resolved, so `waitForCondition(streamCallCount===1 && prepareCallCount===1)` timed out.
