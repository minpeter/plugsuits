# Learnings

## [2026-03-09] Session Start
- Worktree: /Users/minpeter/github.com/minpeter/plugsuits-harness-decoupling
- Branch: work/harness-cea-decoupling (created from main @ badc5c7)
- Existing packages: packages/cea, packages/harness
- Bun workspace: "packages/*" (wildcard - no need to add explicitly)
- Root build script must be updated: "harness → [tui, headless] → cea"
- harness/tsconfig.json: extends ../../tsconfig.base.json, rootDir: ./src, outDir: ./dist
- harness/package.json: type: module, main: ./dist/index.js, types: ./dist/index.d.ts
- harness peerDeps: typescript ^5, zod ^4
- harness build script: "tsc"
- Root tsconfig.json is NOT a composite/references-based config — it's a simple standalone config
- changeset config: access: public, baseBranch: main, no fixed/linked packages

## [2026-03-09] Pre-Refactor Baseline
- Test suite: `bun test packages/harness/src packages/cea/src --timeout 30000`
- Result: 576 pass, 7 fail, 5 errors (583 tests across 44 files)
- Failures:
  - compaction E2E test (real model, 8k forced limit) - compaction not firing
  - compaction E2E with tool calls - schema error (type: "None")
  - Some tests have unhandled errors between tests (module not found: @ai-sdk-tool/harness)
- Headless event types (from source): user, assistant, tool_call, tool_result, error
- Evidence saved to: .sisyphus/evidence/baseline/

## [2026-03-09] SessionManager Extraction
- Added `packages/harness/src/session.ts` with instance-based `SessionManager` and exported it from harness index.
- CEA now reuses a shared `SessionManager` via `globalThis.__ceaSessionManager` in CLI, headless, todo middleware, and todo-write paths so session IDs stay consistent after deleting `packages/cea/src/context/session.ts`.
- `bun run build` passes after the refactor.
- `bun test packages/harness/src packages/cea/src --timeout 30000` still fails only in the pre-existing harness compaction E2E tests; evidence saved to `.sisyphus/evidence/task-8-session.txt`.

## [2026-03-09] Command Registry Extraction
- Added `packages/harness/src/commands.ts` with shared command types, registry state, parsing/execution helpers, `SkillCommandResult`, `configureCommandRegistry`, and generic `createHelpCommand`.
- `packages/harness/src/index.ts` now re-exports the command registry API so CEA can consume it from `@ai-sdk-tool/harness`.
- `packages/cea/src/commands/index.ts` is now a thin compatibility layer that re-exports harness commands and injects CEA's skill loader via `configureCommandRegistry()`.
- Deleted `packages/cea/src/commands/types.ts` and `packages/cea/src/commands/help.ts`; CEA command implementations now import command types from harness.
- `bun run build` passes after the extraction; `bun test packages/harness/src packages/cea/src --timeout 30000` still fails only in the pre-existing harness compaction E2E tests (`compacts after multiple long conversation turns`, `compaction with tool calls preserves tool-call/result pairs`).

## [2026-03-11] Nonblocking integration verification on decoupling branch
- `work/harness-cea-decoupling` already contained the nonblocking-compaction functional commits (`7b41c02`, `03d45fb`, `85815eb`, `c4946c2`, `1088efa`) before this run, so no additional cherry-pick was required.
- `git log --left-right --cherry-pick work/harness-cea-decoupling...work/nonblocking-compaction` showed only one patch-unique lint commit on the source branch (`856aeff`), while equivalent nonblocking logic was already present on target.
- Validation pipeline passed after normalizing local unstaged work: `bun run typecheck`, `bun run test` (700 pass), and `bun run build`.
