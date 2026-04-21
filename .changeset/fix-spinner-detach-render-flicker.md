---
"@ai-sdk-tool/tui": patch
---

Coalesce the spinner-detach render with the first-visible-part render so the editor no longer briefly jumps up when a tool call starts. `createStreamingLoaderClearer` now calls `detachForegroundSpinner` directly (pure DOM mutation, no `requestRender`) instead of the full `clearStatus`, letting the stream-loop's trailing `tui.requestRender()` fold the spinner removal and the first handler's content append into a single render frame.
