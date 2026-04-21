---
"@ai-sdk-tool/tui": patch
---

Suppress the idle status placeholder on every first `text-start` regardless of turn phase, and reset the per-step flag on each `start-step` boundary so the suppression re-fires for every SDK-internal text segment. This fixes two cases where the status slot stayed at 2 lines during final-response streaming: (1) simple non-tool replies on the very first turn (`phase === "new-turn"`), and (2) multi-step turns where the SDK emits more than one `text-start` within a single stream (e.g. text → tool-call → text). Tool-related parts still restore the placeholder to "normal" so spinner mounting doesn't shift.
