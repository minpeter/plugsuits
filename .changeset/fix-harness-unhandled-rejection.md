---
"@ai-sdk-tool/harness": patch
---

Silence unhandled rejections on createAgent stream result promises. When the underlying `streamText()` rejects its internal DelayedPromise fields (for example with `NoOutputGeneratedError` after an empty provider stream), the `totalUsage` promise was never awaited by downstream consumers and caused a process-level `unhandledRejection` crash. The fix attaches no-op rejection handlers to all four promise-returning fields (`finishReason`, `response`, `usage`, `totalUsage`) while returning the original promise instances, so callers still receive rejections normally when they do await them.
