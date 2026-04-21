---
"@ai-sdk-tool/harness": patch
"@ai-sdk-tool/tui": patch
"@ai-sdk-tool/headless": patch
---

Surface the "prompt processing" state that previously looked frozen. The harness loop now exposes `onStreamStart` and `onFirstStreamPart` hooks around the `agent.stream()` call site, the TUI shows a `Processing...` loader during turn preparation and switches to `Working...` once the LLM request is in flight, and headless emits a `turn-start` trajectory annotation alongside a matching `onStreamStart` callback so any agent runtime can signal activity before the first chunk arrives. The TUI startup token probe also runs non-blocking (fire-and-forget) so the editor accepts input immediately on launch; the context-usage footer starts from the estimated count and quietly upgrades to the real value once the probe resolves.
