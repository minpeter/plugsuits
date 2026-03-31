# @plugsuits/minimal-agent

## 0.2.1

### Patch Changes

- Updated dependencies [5aaef15]
  - @ai-sdk-tool/headless@2.0.0
  - @ai-sdk-tool/tui@2.0.0

## 0.2.0

### Minor Changes

- 5a8b087: feat: decouple shared runtimes and simplify context footer text

  - split the shared harness, terminal UI, and headless runner into reusable workspace packages with expanded session, command, and compaction infrastructure
  - unify the `plugsuits` CLI around the shared runtimes, improve `/compact` behavior, and make file read failures more actionable
  - remove the `Context:` prefix from footer-style context usage displays so the TUI shows a cleaner token summary across agents

### Patch Changes

- Updated dependencies [badc5c7]
- Updated dependencies [5a8b087]
- Updated dependencies [618d458]
  - @ai-sdk-tool/harness@1.1.0
  - @ai-sdk-tool/tui@1.0.0
  - @ai-sdk-tool/headless@1.0.0
