---
"plugsuits": minor
"@ai-sdk-tool/harness": minor
---

Migrate token usage naming from `promptTokens`/`completionTokens` to `inputTokens`/`outputTokens` to align with Vercel AI SDK v6.

Fix model-agnostic compaction bug: prevent `totalTokens` from being misattributed as `promptTokens` when the provider omits prompt token counts. Invalidate stale `actualUsage` after message changes and compaction.

Remove compact-test model entry — use `COMPACTION_DEBUG=1 CONTEXT_LIMIT_OVERRIDE=<N>` to simulate small context windows on any model.
