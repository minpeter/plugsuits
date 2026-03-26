# Decisions

## [2026-03-09] Architecture Decisions
- Package build order: harness → tui → headless → cea (sequential, not parallel build)
- tui peer deps: @ai-sdk-tool/harness, @mariozechner/pi-tui, ai, zod
- headless peer deps: @ai-sdk-tool/harness, ai, zod
- No abstract base classes — direct usage only
- ToolCallView stays in CEA (15 CEA-specific renderers)
- Pi-tui is NOT abstracted — used directly as peer dep
- Headless JSONL event output must be byte-identical to pre-refactor
- Breaking changes: harness 1.0.0, cea 2.0.0, tui 0.1.0, headless 0.1.0

## [2026-03-11] Branch integration decision
- Treated this as verification/integration completion rather than forced cherry-pick replay, because the five nonblocking functional commits were already present (different hashes but equivalent content) on `work/harness-cea-decoupling`.
- Committed only real local unstaged work (`packages/cea/package.json`, `packages/harness/src/message-history.test.ts`) to satisfy clean-tree precondition and preserve atomicity.
