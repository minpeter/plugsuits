# Decisions — compaction-redesign-v2

## 2026-03-27 — Architecture Decisions

### Decision 1: thresholdRatio in CompactionPolicyInput, not CompactionConfig
The `thresholdRatio` needs to be added to both the policy input AND the CompactionConfig type.
- `CompactionConfig.thresholdRatio?: number` — stored in history config
- `CompactionPolicyInput.thresholdRatio?: number` — passed to policy functions
- Default: 0.5 (50% of context window)

### Decision 2: overflow-detection.ts is a NEW file
The existing `shouldCompactFromContextOverflow()` in `compaction-policy.ts` should be kept for backward compat but marked deprecated. The new `overflow-detection.ts` will be the canonical source.

### Decision 3: Progressive pruning levels
Goose-inspired: [0, 10, 20, 50, 100]% — but "0%" means "no pruning, return as-is" for try-first approach.

### Decision 4: Structured prompt redesign scope
The `DEFAULT_COMPACTION_USER_PROMPT` will be completely rewritten. The existing `COMPACT_COMPACTION_PROMPT` (used at <4096 context) should also be updated with the structured format.

## 2026-03-27 — Task 16: Existing Test Suite Verification

### Verification Complete ✓
All 792 tests pass across 7 packages (0 TypeScript errors, build successful)

### Test Coverage Audit (Compaction Redesign v2 Features)
- ✓ `isContextOverflowError` detection — 34 tests in overflow-detection.test.ts
- ✓ `progressivePrune` strategy — 18 tests in tool-pruning.test.ts
- ✓ `thresholdRatio` policy — 13 tests in compaction-policy.test.ts
- ✓ Split-turn summary generation — 77+23 tests in checkpoint-history*.test.ts
- ✓ Prune callbacks (onPrune) — 13 tests in compaction-orchestrator.test.ts
- **No missing critical tests** — all new features fully covered

### Evidence
Saved to `.sisyphus/evidence/task-16-test-suite.txt`

- 2026-03-27 F1 audit verdict: APPROVE. The redesign remains compliant with the audited guardrails: compact() public shape preserved, no FileOperations/extractFileOps in harness, JSONL event protocol unchanged, and no provider constructor calls in harness.
