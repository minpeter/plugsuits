# @ai-sdk-tool/harness

## 0.2.1

### Patch Changes

- 1f1f77d: docs(harness): add README and JSDoc to public API

  Adds a comprehensive README for the `@ai-sdk-tool/harness` package covering
  installation, quick start, full API reference, and advanced usage examples.
  Adds JSDoc comments to `agent.ts`, `loop.ts`, and `types.ts` for IDE
  discoverability and generated documentation.

  Closes #38

## 0.2.0

### Minor Changes

- b519c2a: feat: add incremental context compaction feature

  - Automatic and manual compaction when token limits are approached
  - Turn splitting support for preserving conversation continuity
  - File operation tracking (read/edit) in summaries
  - Advanced token estimation (image, tool calls)
  - Configurable via CompactionConfig interface
  - 47 comprehensive tests included

## 0.1.1

### Patch Changes

- 62b4261: Set up Changesets-based release automation for the monorepo.
  Add the `pss` CLI alias for `plugsuits` and switch internal harness dependency to a publish-safe semver range.
