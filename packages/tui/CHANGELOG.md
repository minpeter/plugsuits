# @ai-sdk-tool/tui

## 2.0.0

### Major Changes

- 5aaef15: fix: publish @ai-sdk-tool/headless and @ai-sdk-tool/tui to npm

  Initial major release of headless and tui packages to npm registry.
  Republish plugsuits with corrected dependency versions.

## 1.0.0

### Minor Changes

- 5a8b087: feat: decouple shared runtimes and simplify context footer text

  - split the shared harness, terminal UI, and headless runner into reusable workspace packages with expanded session, command, and compaction infrastructure
  - unify the `plugsuits` CLI around the shared runtimes, improve `/compact` behavior, and make file read failures more actionable
  - remove the `Context:` prefix from footer-style context usage displays so the TUI shows a cleaner token summary across agents

- 618d458: refactor: ship the segment-first compaction system across the shared runtimes

  - move harness compaction onto segment-based state and prepared artifacts
  - share compaction orchestration across TUI and headless runtimes
  - guard CEA model calls from empty prepared message lists under tight context budgets

### Patch Changes

- Updated dependencies [badc5c7]
- Updated dependencies [5a8b087]
- Updated dependencies [618d458]
  - @ai-sdk-tool/harness@1.1.0
