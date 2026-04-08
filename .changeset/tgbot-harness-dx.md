---
"@ai-sdk-tool/harness": patch
---

Add session lifecycle and formatting APIs:
- `CheckpointHistory.fromSession()`: async factory that restores sessions from SessionStore without double-persisting messages
- `CheckpointHistory.resetForSession()`: switch to a new sessionId while preserving compaction/pruning config
- `SessionStore.deleteSession()`: delete a session's JSONL file from disk
- `formatTokens()` / `formatContextUsage()`: token count and context usage formatting utilities (moved from consumer packages)
