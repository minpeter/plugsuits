# @ai-sdk-tool/tui

## 3.0.1

### Patch Changes

- 2f62589: Prevent infinite compaction loops in small-context scenarios. Adds a per-turn compaction cap (`maxAcceptedCompactionsPerTurn`, default 10), relaxes the compaction acceptance gate to reject only on `fitsBudget` failures, and introduces opt-in task-aware 2-step compaction (enabled in CEA) that extracts the current user turn's task intent before summarizing to preserve the work context. Turn boundaries are now tracked via `notifyNewUserTurn()` called from TUI and headless runtime.
- Updated dependencies [2f62589]
- Updated dependencies [2f62589]
  - @ai-sdk-tool/harness@1.2.1

## 3.0.0

### Patch Changes

- Updated dependencies [18bfebb]
  - @ai-sdk-tool/harness@1.2.0

## 2.0.1

### Patch Changes

- 9ba8e20: fix: add .js extensions to ESM imports for Node.js compatibility
- Updated dependencies [9ba8e20]
  - @ai-sdk-tool/harness@1.1.1

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
