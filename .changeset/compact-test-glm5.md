---
"plugsuits": patch
"@ai-sdk-tool/harness": patch
---

Fix model-agnostic compaction bug: prevent totalTokens from being misattributed as promptTokens when the provider omits prompt token counts. Invalidate stale actualUsage after message changes and compaction to ensure consistent compaction decisions across all models.

Remove compact-test model entry — use `COMPACTION_DEBUG=1 CONTEXT_LIMIT_OVERRIDE=<N>` instead to simulate small context windows on any model.

Make `CONTEXT_LIMIT_OVERRIDE` apply to UI context display via `getModelTokenLimits()`.
