# Decisions

## 2026-03-24 Session Start
- Scope: Layer A only — overflow recovery fix, no tool output limits
- Min context window: 8K support
- UX on exhaustion: fail-fast error (returns {success:false, error:"..."}, NOT throw)
- Lean compaction: Separate private path (compactForOverflowRecovery)
- TDD: RED-GREEN-REFACTOR
- Budget-based check: tokensAfter < contextLimit - reserveTokens (not tokensAfter < tokensBefore)
- contextLimit=0 means unlimited → success = any reduction (tokensAfter < tokensBefore)

## Must NOT change
- compact() method
- CompactionOrchestrator.handleOverflow()
- loop.ts
- isAtHardContextLimit(), needsCompaction(), blockAtHardLimit()
- CompactionConfig or PruningConfig fields

## 2026-03-25 Task execution decisions
- Added `private recoveryInProgress = false` and guarded `handleContextOverflow()` entry to avoid concurrent mutation of `messages` during overflow recovery.
- Kept end-of-method throw behavior in `handleContextOverflow()` unchanged per phased rollout plan.
- Reset `this.actualUsage = null` only on successful recovery branches (prune, compact, aggressive-compact, truncate success).
