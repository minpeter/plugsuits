---
"@ai-sdk-tool/tui": patch
---

Suppress the idle status placeholder the moment the final assistant text starts streaming on an intermediate-step turn, so the editor sits flush below the response during and after streaming. Phase gating keeps `new-turn` turns (simple non-tool responses, or intermediate commentary that precedes a tool call) on the stable 2-line slot, and a defensive un-suppress on any tool-related part restores the placeholder if a multi-step turn produces more tool calls after text.
