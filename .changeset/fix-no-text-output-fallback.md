---
"@ai-sdk-tool/headless": patch
---

Remove "(no text output)" fallback from agent step events in stream processor. Tool-call-only steps now emit an empty string instead of the placeholder, preventing downstream consumers from concatenating the literal into final responses.
