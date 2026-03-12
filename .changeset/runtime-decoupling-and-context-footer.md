---
"@ai-sdk-tool/harness": minor
"@ai-sdk-tool/tui": minor
"@ai-sdk-tool/headless": minor
"plugsuits": minor
"@plugsuits/minimal-agent": minor
---

feat: decouple shared runtimes and simplify context footer text

- split the shared harness, terminal UI, and headless runner into reusable workspace packages with expanded session, command, and compaction infrastructure
- unify the `plugsuits` CLI around the shared runtimes, improve `/compact` behavior, and make file read failures more actionable
- remove the `Context:` prefix from footer-style context usage displays so the TUI shows a cleaner token summary across agents
