# Decisions — legacy-cleanup

## 2026-03-24

- Added token-tracking methods directly to `CheckpointHistory` instead of introducing shared helpers, to keep change scope minimal and aligned with current migration phase.
- `updateActualUsage` stores `updatedAt` as `Date.now()` (number timestamp) to align with `compaction-types.ts` shape used by checkpoint flow.
- `getContextUsage` prefers `promptTokens` (fallback `totalTokens`) for `used` in `source: "actual"` mode, matching requested behavior for UI context display.

- Implemented `CheckpointHistory` context-limit and compaction control APIs by reusing `compaction-policy.ts` functions (`needsCompactionFromUsage`, `isAtHardContextLimitFromUsage`, `shouldStartSpeculativeCompaction`, `getRecommendedMaxOutputTokens`) instead of embedding local formulas.
- Chose a positive fallback (`8192`) for `getRecommendedMaxOutputTokens()` when no explicit context limit is configured to keep existing runtime expectations/tests stable.

## 2026-04-15

- Removed `SessionStore` entirely instead of preserving a deprecated wrapper; only `encodeSessionId`, `decodeSessionId`, and `SessionData` remain as shared primitives for file-backed snapshot persistence.
- Chose to keep `CheckpointHistory.resetForSession()` as an in-memory reset hook only; session IDs no longer drive persistence inside the class.
- Kept verification grounded in successful `build`, `typecheck`, and `test` because local LSP diagnostics were unavailable due to missing `biome` in PATH.
