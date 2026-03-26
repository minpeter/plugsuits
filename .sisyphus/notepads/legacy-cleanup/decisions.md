# Decisions — legacy-cleanup

## 2026-03-24

- Added token-tracking methods directly to `CheckpointHistory` instead of introducing shared helpers, to keep change scope minimal and aligned with current migration phase.
- `updateActualUsage` stores `updatedAt` as `Date.now()` (number timestamp) to align with `compaction-types.ts` shape used by checkpoint flow.
- `getContextUsage` prefers `promptTokens` (fallback `totalTokens`) for `used` in `source: "actual"` mode, matching requested behavior for UI context display.

- Implemented `CheckpointHistory` context-limit and compaction control APIs by reusing `compaction-policy.ts` functions (`needsCompactionFromUsage`, `isAtHardContextLimitFromUsage`, `shouldStartSpeculativeCompaction`, `getRecommendedMaxOutputTokens`) instead of embedding local formulas.
- Chose a positive fallback (`8192`) for `getRecommendedMaxOutputTokens()` when no explicit context limit is configured to keep existing runtime expectations/tests stable.
