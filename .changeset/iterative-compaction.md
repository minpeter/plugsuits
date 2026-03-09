---
"@ai-sdk-tool/harness": minor
---

feat: iterative compaction — pass previous summary to summarizeFn for context-aware updates

- Extended `summarizeFn` signature with optional `previousSummary` parameter (backwards compatible)
- `performCompaction()` now passes combined previous summaries to `summarizeFn`
- After compaction, previous summaries are merged into a single entry (always 1 summary)
- `defaultSummarizeFn` includes previous context in structured format when available
- `createModelSummarizer` uses `ITERATIVE_SUMMARIZATION_PROMPT` when updating existing summaries
- Added `ITERATIVE_SUMMARIZATION_PROMPT` export for customization
- Added `iterativePrompt` option to `ModelSummarizerOptions`
