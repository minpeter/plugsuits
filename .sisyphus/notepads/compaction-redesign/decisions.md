# Architectural Decisions

## 2026-03-24 Session Start

### Core Architecture: Checkpoint-Pointer Model
- Replace segments-based MessageHistory with flat append-only array + summaryMessageId pointer
- All messages stored permanently (no deletion)
- Active context = messages from checkpoint onwards (inclusive)
- Summary stored as assistant, returned as user role in getMessagesForLLM()

### File Persistence: JSONL
- One .jsonl file per session, append-only
- Path: `.plugsuits/sessions/{sessionId}.jsonl`
- Session JSONL ≠ trajectory JSONL (separate formats)
- JSONL line types: SessionHeaderLine, MessageLine, CheckpointLine

### Summary Role Rewrite
- Storage: role "assistant", isSummary: true
- LLM output: role "user" (injected as new briefing, not past self-speech)

### Continuation Messages: 3 Variants
- "manual": user requested compact
- "auto-with-replay": auto compact, last user request preserved
- "tool-loop": compact mid-tool-chain

### Scope Limits (from Momus review)
- NO dual visibility per message (over-engineering for library)
- NO plugin hooks (summarizeFn is sufficient)
- NO multi-session management in V1
- NO DB persistence (JSONL only)
- NO changes to runAgentLoop
- Keep DEFAULT_COMPACTION_USER_PROMPT content (already handoff-quality)

## 2026-03-24 Task T4 Decisions

- `CheckpointHistory.addModelMessages()` validates tool sequence on the full candidate history (`current + incoming`) before committing, ensuring valid pairs survive across add boundaries.
- Persistence strategy remains append-only JSONL via `SessionStore.appendMessage` with best-effort writes; memory state is source-of-truth at runtime.

## 2026-03-24 Task T14 follow-up decisions

- Keep `CompactionOrchestrator` backward-compatible for consumers still passing history per method call (constructor without history).
- Legacy branch (`prepareSpeculativeCompaction/applyPreparedCompaction`) remains active for headless/tui flow until all consumers are fully checkpoint-native.
