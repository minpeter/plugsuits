---
"@ai-sdk-tool/harness": patch
"@ai-sdk-tool/tui": patch
"@ai-sdk-tool/headless": patch
---

Add `defineAgent`, `createAgentRuntime`, and `AgentSession` runtime layer to harness. Add `runAgentSessionTUI` and `runAgentSessionHeadless` session adapter helpers to tui and headless. Remove deprecated `SessionStore`, `CheckpointHistory.fromSession()`, and legacy token field aliases (`completionTokens`, `promptTokens`).
