---
"plugsuits": patch
---

Silence unhandled rejections in `buildAgentStreamWithTodoContinuation`. The todo-continuation wrapper creates new promise chains via async IIFEs and `.then()` derivations that fan out from `stream.finishReason`. When the base stream rejects (for example with `NoOutputGeneratedError`), callers that don't await every branch of the fan-out would previously crash the process with an unhandled rejection. Adds no-op `.catch()` guards on `continuationDecision`, `response`, and `finishReason` while still returning the same promise instances so actual awaiters continue to receive rejections.
