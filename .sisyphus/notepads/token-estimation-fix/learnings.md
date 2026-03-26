# Learnings

## 2026-03-26 Session Start
- Baseline: 185 tests passing in harness
- `estimateTokens()` uses chars/4 for Latin, chars/1.5 for CJK — signature MUST NOT change (12+ callers)
- `getCurrentUsageTokens()` at L800-802: returns `actualUsage?.totalTokens ?? getEstimatedTokens()`
- `getEstimatedTokens()` at L322-330: sums active messages, does NOT include systemPromptTokens
- `systemPromptTokens` private field at L170 — only added in `getRecommendedMaxOutputTokens()` (L456)
- `handleContextOverflow()` sets `this.actualUsage = null` on all 4 success paths (L654, 664, 674, 684)
- `getRecommendedMaxOutputTokens()` at L449-456: does `getCurrentUsageTokens() + systemPromptTokens` — WILL double-count after T5 fix
- `needsCompaction()` does NOT use `getCurrentUsageTokens()` — uses `actualUsage.totalTokens` or `getEstimatedTokens()` directly

## Key Types
- `ActualTokenUsage`: `{promptTokens, completionTokens, totalTokens, updatedAt: Date}`
- `ModelMessage` roles: "user" | "assistant" | "tool" | "system"
- Tool result messages: role="tool", content=[{type:"tool-result", toolCallId, toolName, output}]
- Tool call parts in assistant: {type:"tool-call", toolCallId, toolName, input}

## Token Ratio Decision
- `TOOL_RESULT_CHARS_PER_TOKEN = 3` (midpoint, openclaw=2 too aggressive, chars/4=too low)
- `TOOL_CALL_CHARS_PER_TOKEN = 3` (JSON args are code-dense)
- CJK handling: keep existing CJK_CHARS_PER_TOKEN=1.5 logic for tool content too
- estimateMessageTokens(): new function, does NOT change estimateTokens()

## Parallelization Notes
- T1 → token-utils.test.ts (safe to run with T2/T3)
- T2 → checkpoint-history.test.ts (conflicts with T3 — run T2 then T3)
- T3 → checkpoint-history.test.ts (after T2)
- T4 → token-utils.ts (safe parallel with T5/T6)
- T5 → checkpoint-history.ts + test (conflicts with T6 — run T5 then T6)
- T6 → checkpoint-history.ts + test (after T5)

## 2026-03-26 Review Follow-up
- Re-verified `getRecommendedMaxOutputTokens()` now uses `estimateMessageTokens(message)` in the `messagesForLLM` branch at `packages/harness/src/checkpoint-history.ts:453-458`
- Harness tests pass at 196/196 and workspace `pnpm run typecheck` passes after the follow-up fix
- No new LSP diagnostics on `packages/harness/src/checkpoint-history.ts`; prior undercount concern for tool-call/tool-result heavy prompts is resolved

## 2026-03-26 Task 1: RED Tests Complete
- **3 tests added to token-utils.test.ts** (lines 112-167):
  - Test A: Code with newlines/quotes estimates > rawTextLength/3.5 (RED: 1612 > 1229)
  - Test B: Plain string estimates != estimateTokens (RED: 28 != 12)
  - Test C: Empty string still > 0 (RED: 12 != 0)
- **1 test added to checkpoint-history.test.ts** (lines 1200-1263):
  - Test D: Speculative fires before blocking (RED: blocking fires first, speculativeFirstAt=null)
- All 4 tests FAIL with current implementation as expected
- Commit: f29f04e "test: RED tests for deflated tool-result estimation and speculative ordering"

### Why Each Test FAILs (Current Behavior)
1. **Test A**: `estimateMessageTokens()` uses `JSON.stringify(output)` which inflates by 100-200% for code with \n and "
2. **Test B**: `JSON.stringify("plain string")` = `'"plain string"'` adds 2 chars → different token count
3. **Test C**: `JSON.stringify("")` for empty output still wraps in field, estimates > 0
4. **Test D**: Overestimation causes `isAtHardContextLimit()` to fire BEFORE `shouldStartSpeculativeCompactionForNextTurn()`

### Why These Tests Are Correct (After Fix)
1. Test A: Fix removes JSON.stringify wrapping → estimate ≈ rawTextLength/4 (≤ rawTextLength/3.5)
2. Test B: Direct string pass-through → same as `estimateTokens(string)`
3. Test C: Empty output = 0 tokens (no padding/wrapping)
4. Test D: Accurate estimation allows speculative gate to fire at 70% BEFORE blocking at 100%
