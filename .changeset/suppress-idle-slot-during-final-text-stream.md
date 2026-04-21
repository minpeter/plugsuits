---
"@ai-sdk-tool/tui": patch
---

Suppress the idle status placeholder the moment the final assistant text starts streaming (on the first `text-start` part), so the editor sits flush below the response both during and after streaming. Previously the 2-line placeholder appeared below the streaming text and collapsed to 0 at the end, producing a visible shift.
