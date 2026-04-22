---
"@ai-sdk-tool/tui": patch
"plugsuits": patch
"@plugsuits/minimal-agent": patch
---

Make `/new` feel instant by rendering the fresh session before running the usage probe.

- Previously `handleNewSessionAction` awaited both the session swap and a model-provider usage probe (system prompt + tool-schema baseline token count) before repainting, so every `/new` waited one network round-trip to the provider.
- Now the session swap still blocks (disk save + history replace), but the usage probe is fired via `runBackgroundUsageProbe()` after the new-session UI renders. The existing `usageProbeGeneration` and history-revision guards already discard stale updates if the user sends a new message before the probe returns, so context-pressure accuracy is preserved.
- Renamed `runBackgroundStartupProbe` to `runBackgroundUsageProbe` since it's now reused for both startup and `/new`.
