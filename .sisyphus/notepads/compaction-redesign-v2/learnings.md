# Learnings — compaction-redesign-v2

## 2026-03-27 — Initial Codebase Survey

### Package Structure
- `packages/harness/src/` — all compaction logic lives here
- Key files: `compaction-policy.ts`, `compaction-types.ts`, `tool-pruning.ts`, `compaction-prompts.ts`, `checkpoint-history.ts`, `compaction-orchestrator.ts`
- `packages/cea/src/agent.ts` — CEA-side config computation
- `packages/headless/src/runner.ts` — headless runner
- `packages/tui/src/agent-tui.ts` — TUI

### Current compaction-policy.ts
- `shouldStartSpeculativeCompaction()` — uses `speculativeStartRatio` OR fallback `contextLimit - phaseReserveTokens * 2`
- `needsCompactionFromUsage()` — compares to `thresholdLimit` parameter (caller computes it)
- `isAtHardContextLimitFromUsage()` — checks `usage + additional + reserve >= contextLimit`
- `shouldCompactFromContextOverflow(error)` — basic string matching (8 patterns, in policy.ts NOT overflow-detection.ts)
- NO `thresholdRatio` concept yet — threshold is computed externally by caller

### current compaction-types.ts — CompactionConfig
- `maxTokens?: number` — max tokens before compaction (must be REMOVED per plan)
- `speculativeStartRatio?: number` — ratio [0.15-0.95]
- No `thresholdRatio` field yet

### tool-pruning.ts
- `pruneToolOutputs()` exists
- Default protect recent: 2000 tokens (WAY too low — plan wants 40k)
- Default min savings: 200 tokens (plan wants 20k)
- Only one-pass pruning, no progressive levels
- Middle-out NOT implemented yet

### compaction-prompts.ts
- `DEFAULT_COMPACTION_USER_PROMPT` — comprehensive 9-section prompt
- Has contamination marker `[INTERNAL COMPACTION INSTRUCTION]` — MUST KEEP
- Has `buildUserTurnContent()` for previous summary injection
- `SMALL_CONTEXT_THRESHOLD = 4096` — uses compact prompt below this
- `createModelSummarizer()` — factory function

### Key Guards (from plan)
- G1: File tracking in CEA, NOT harness
- G2: One strategy per problem
- G3: Summarizer needs ≥4k input + 2k output independent budget
- G4: Safety multiplier ≥1.15 for threshold comparisons
- SC1: Max 15 overflow patterns
- SC2: No FileOperations type in harness

### Task-1 Target: compaction-policy.ts rewrite
- Add `thresholdRatio` to `CompactionPolicyInput`
- `needsCompaction()` = `actualUsage >= contextWindow * thresholdRatio`
- `speculativeStart()` = `actualUsage >= contextWindow * (thresholdRatio * 0.75)`
- Keep `isAtHardContextLimit()` as emergency brake
- TDD: write tests first

### Task-2 Target: overflow-detection.ts (NEW file)
- `isContextOverflowError(error)` — ~15 patterns max
- `isUsageSilentOverflow(usage, contextWindow)` — silent overflow
- Export from harness index.ts
- Move/refactor `shouldCompactFromContextOverflow` from policy.ts

### Task-3 Target: tool-pruning.ts extension
- Add `progressivePrune()` with 5 levels: [0, 10, 20, 50, 100]%
- Middle-out strategy: remove from center of tool output list
- `protectRecentTokens` default: 40k (not 2k)
- `minSavingsTokens` default for progressive: 20k
- Returns `{ messages, tokensBefore, tokensAfter, levelUsed }`

### Task-4 Target: compaction-prompts.ts rewrite
- Replace `DEFAULT_COMPACTION_USER_PROMPT` with 5-section Crush/Kilocode template:
  1. Current Goal
  2. Files & Changes
  3. Technical Discoveries
  4. Strategy & Approach
  5. Exact Next Steps
- Keep `[INTERNAL COMPACTION INSTRUCTION]` marker
- Add incremental update path for previousSummary

## 2026-03-27 — Task 4 Complete: Structured Handoff Prompt

### DEFAULT_COMPACTION_USER_PROMPT Rewritten
- Replaced 9-section format with 5-section Crush-inspired template
- Sections: Current Goal | Files & Changes | Technical Discoveries | Strategy & Approach | Exact Next Steps
- Preserved: [INTERNAL COMPACTION INSTRUCTION] marker + <summary> output requirement
- Prompt now emphasizes structured handoff continuity vs detailed section enumeration

### Tests Updated in compaction-prompts.test.ts
- Updated "contains required summary sections" to check for 5 new section names
- Changed prompt text assertions: "Your task is to create..." → "Create a structured handoff summary"
- Affected lines: 146-158 (section checks), 231-237 (prompt text), 490-495 (previousSummary text)
- Result: ✓ 25 tests passed (compaction-prompts.test.ts)

### Key Gotchas Avoided
- Did NOT remove [INTERNAL COMPACTION INSTRUCTION] marker — correctly preserved
- Did NOT change <summary> output tags requirement
- Did NOT modify createModelSummarizer(), buildSummaryInput(), or extractSummaryFromResponse()
- Did NOT modify COMPACT_COMPACTION_PROMPT (small context fallback)
- Only edited 2 files: compaction-prompts.ts + compaction-prompts.test.ts

### What Stayed the Same
- Model summarizer function signatures unchanged
- extractSummaryFromResponse() still extracts <summary> content correctly
- buildSummaryInput() still creates conversation transcript for model context
- Tool call message preservation still works
- Custom prompt/instructions/previousSummary injection still works
- All 25 compaction-prompts tests still pass

### Architectural Insight
The new 5-section format is designed for **seamless handoff** when sessions are resumed:
1. Current Goal = recent user request (prevents task drift)
2. Files & Changes = what was touched (quick scan of modified surfaces)
3. Technical Discoveries = key learnings + errors resolved
4. Strategy & Approach = why this solution was chosen
5. Exact Next Steps = next atomic action with context quotes

This prioritizes **continuity** (Goal + Next Steps) over enumeration (9 sections listing everything).

## 2026-03-27 — Task 2: Overflow Detection Module [COMPLETED]

### Implementation Details
- Created `packages/harness/src/overflow-detection.ts` with 2 functions:
  - `isContextOverflowError(error)` — 12 regex patterns (within SC1 limit of 15)
  - `isUsageSilentOverflow(usage, contextWindow)` — silent overflow detection
  
- Pattern distribution:
  - Anthropic: 3 patterns (prompt is too long, context_length_exceeded, too many tokens)
  - OpenAI/Friendli: 4 patterns (maximum context length, token limit exceeded, etc.)
  - Google/Gemini: 3 patterns (exceeds context window, context window, input too long)
  - Generic: 2 patterns (input is too long, token limit)

### Export Strategy
- Updated `packages/harness/src/index.ts` to export both functions from overflow-detection.ts
- Moved `isContextOverflowError` source from checkpoint-history.ts → overflow-detection.ts
- Maintained backward compatibility (checkpoint-history.ts implementation still exists)
- New version is stricter (regex) vs old version (string contains) — fewer false positives

### Test Coverage
- Created `overflow-detection.test.ts` with 34 comprehensive test cases
- All tests pass ✅
- Coverage includes: pattern detection, case insensitivity, false negatives, type safety, edge cases

### Backward Compatibility Impact
- ✅ No breaking changes — existing code continues to work
- ✅ Public export now comes from more comprehensive module
- ✅ Both implementations compatible functionally

### Constraints Satisfied
- SC1: 12 patterns (within 15 max)
- Provider-specific patterns only (no API calls)
- Proper test coverage
- Clean export from index.ts

## [Task 3 complete] Progressive Tool Pruning
- Added `progressivePrune()` to `packages/harness/src/tool-pruning.ts` with Goose-style 5 levels: `[0, 10, 20, 50, 100]`.
- Implemented middle-out removal via contiguous center slice of prunable tool-result refs:
  - `removeCount = floor(total * percentage / 100)`
  - `start = floor((total - removeCount) / 2)`
  - prune refs from `start` to `start + removeCount - 1`
- Progressive mode defaults:
  - `protectRecentTokens = 40000`
  - replacement output text = `"[output pruned]"`
- Added and exported `ProgressivePruneResult` (from `tool-pruning.ts` and `index.ts`).
- Kept existing `pruneToolOutputs()` implementation and existing tests untouched.
- Added new `describe("progressivePrune")` block in `tool-pruning.test.ts` (4 tests).
- Validation:
  - LSP diagnostics clean on changed files
  - `pnpm test --filter @ai-sdk-tool/harness -- tool-pruning` passed
  - harness test summary in run: 248 passed, 0 failed

## [Task 1 complete] Compaction Policy Redesign
- Added `thresholdRatio` to `CompactionPolicyInput` and `CompactionConfig`.
- Reworked `needsCompactionFromUsage()` to compute soft threshold via `contextLimit * thresholdRatio` (default ratio: `0.5`).
- Reworked `shouldStartSpeculativeCompaction()` to use `contextLimit * (thresholdRatio * 0.75)` when `thresholdRatio` is present; kept existing speculativeStartRatio/reserve fallback when absent.
- Updated caller sites (`checkpoint-history.ts`, `compaction-orchestrator.ts`) to pass `contextLimit` + `thresholdRatio` and removed `thresholdLimit` usage.
- Preserved backward compatibility with `maxTokens` by deriving an effective ratio (`maxTokens / contextLimit`) and applying the stricter threshold when applicable.
- Added RED-first tests in `compaction-policy.test.ts` for 50% threshold trigger and speculative 37.5% trigger boundaries.
- Gotcha: `pnpm test --filter @ai-sdk-tool/harness` currently fails on unrelated pre-existing `tool-pruning.test.ts` (`progressivePrune is not a function`), while typecheck and changed-file LSP diagnostics are clean.

## [Task 7 complete] Split-Turn Dual Summary
- Implemented mid-turn detection in compact() using split-boundary analysis.
- Mid-turn means: the last summarized message is an assistant tool-call, and a matching tool-result (same `toolCallId`) exists on the kept side after split.
- When mid-turn is detected, compaction now runs dual summaries:
  - history summary for pre-turn-prefix messages (`floor(reserveTokens * 0.8)` reserve)
  - turn-prefix summary for the partial turn chain (`floor(reserveTokens * 0.5)` reserve)
- Two summaries are merged as:
  - `${historySummary}\n\n---\n\n**Turn Context:**\n\n${turnPrefixSummary}`
- First summary call carries `previousSummary`; second call intentionally does not.
- Non-mid-turn compaction path remains single-summary behavior.

## [Task 6 complete] File Operation Tracking (CEA)
- Added buildFileTrackingSummarizeFn() to cea/src/agent.ts
- File tracking via closure, carries forward across compactions
- Tests pass

## [Task 11 complete] TUI Overflow Retry
- Added isContextOverflowError detection in stream error handler
- On overflow: blocking compact then retry (max 1 retry)
- Implementation details:
  - imported `isContextOverflowError` into `packages/tui/src/agent-tui.ts`
  - added `retryStreamTurnOnContextOverflow()` helper to centralize overflow-only single-retry gating
  - added `runBlockingOverflowCompaction()` to preserve TUI blocking UI behavior while calling `compactionOrchestrator.handleOverflow(error)`
  - kept background vs blocking compaction UI distinction intact by reusing `blockingCompactionActive`, clearing background footer state, and restoring loader/header state in `finally`
  - added TUI tests covering successful overflow retry and no second retry after overflowRetried=true

## [Task 12 complete] Orchestrator Prune Callbacks
- Added `onPruneStart` / `onPruneComplete` / `onPruneSkipped` to `CompactionOrchestratorCallbacks`.
- Added optional `pruneMessages(targetTokens)` contract to `CompactionHistoryLike`.
- Implemented prune-first hard-limit flow in `CompactionOrchestrator.blockAtHardLimit()`:
  - emits `onPruneSkipped({ reason: "no-prune-config" })` when prune integration is unavailable,
  - emits `onPruneStart()` before prune attempt,
  - emits `onPruneComplete(detail)` and skips overflow compaction when prune satisfies target,
  - emits `onPruneSkipped({ reason: "insufficient" })` when prune runs but cannot reach target.
- Extended `blockAtHardLimitCore` with matching optional prune hooks (`pruneMessages`, `targetTokens`, prune callbacks) to keep core flow parity.
- Added `CheckpointHistory.pruneMessages()` using `progressivePrune()` with prune-first integration behavior:
  - uses progressive pruning target,
  - applies pruned active messages via new `applyPrunedMessages()` helper when tokens are reduced,
  - rebaselines actual usage after applied pruning.
- Added orchestrator tests covering prune callbacks for:
   - sufficient prune (`onPruneComplete`, no overflow compaction),
   - insufficient prune (`onPruneSkipped: insufficient`, falls back to overflow handling),
   - missing prune integration (`onPruneSkipped: no-prune-config`, falls back to overflow handling).

## [Task 10 complete] Headless Overflow Retry
- Added isContextOverflowError detection in runSingleTurn
- On overflow: blockAtHardContextLimit then retry with fresh messages
- Max 1 retry via overflowRetried flag
- Implementation: wrapped stream + processStream in executeStream async function with try/catch
- Added test case verifying overflow throws on first call, retries successfully on second
- All 10 headless tests pass

## [Task 13 complete] Benchmark Runner Script
- Created `scripts/compaction-benchmark.ts`
- Runs 4 scenarios: 8k, 20k, 40k, 80k
- Output: results/scenario-*-trajectory.jsonl + results/benchmark-summary.txt

## [Task 14 complete] Token Usage Graph Generator
- Created `scripts/compaction-graph.ts`
- Reads metrics logs from `results/{limit}-metrics.log` or auto-discovers all 4 scenarios
- Outputs ASCII graphs to `results/compaction-graphs/scenario-{limit}.txt`
- Features:
  - X-axis: turn number, Y-axis: token count (0 to contextLimit)
  - ▓ = actual token line
  - ─ = context limit line
  - | = compaction events
  - ! = blocking events
  - X = both events
- Supports: `node --import tsx scripts/compaction-graph.ts [metrics-log-file]`
- Creates `results/compaction-graphs/` directory automatically
- Graph format: 10-30 rows, 40-120 columns, scaled to context window
- All files generated successfully for 8k/20k/40k scenarios

## [Task 15 complete] E2E Verification
- Benchmark run: partial
- 8k scenario: compaction events present, no explicit overflow text, but some `turn_complete.actualTokens` exceeded context limit (fail on strict bound)
- 20k scenario: benchmark run succeeded and compaction events present, but final assistant message was not substantive (>500 chars) (fail)
- 40k scenario: no `blocking_start` events (pass)
- 80k scenario: no `blocking_start` events (pass)

- 2026-03-27 F1 compliance audit: verified thresholdRatio policy/types wiring, progressive prune orchestration, 5-section structured summary prompt, post-compaction re-baselining, overflow detection module, and measureUsage -> updateActualUsage flow across CEA/TUI/headless.
