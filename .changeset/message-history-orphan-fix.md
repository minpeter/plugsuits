---
"@ai-sdk-tool/harness": patch
---

fix(harness): remove orphaned tool_result messages after enforceLimit and performCompaction

Adds `ensureNoOrphanedToolResults()` private method to `MessageHistory` that removes
`tool` role messages that lack a preceding `assistant` message with tool-call parts.
This prevents providers from rejecting invalid message sequences when the history is
trimmed at a tool-call/tool-result boundary.

Closes #39
