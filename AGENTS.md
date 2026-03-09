# PROJECT KNOWLEDGE BASE

**Updated:** 2026-03-09 KST
**Branch:** harness-decoupling

## OVERVIEW

`plugsuits` is a Bun + TypeScript monorepo with four packages. The core agent harness (`@ai-sdk-tool/harness`) is model-agnostic and reusable. Terminal UI rendering lives in `@ai-sdk-tool/tui`, JSONL event streaming in `@ai-sdk-tool/headless`, and the full code-editing agent implementation in `@ai-sdk-tool/cea`.

## STRUCTURE

```text
plugsuits/
|- packages/
|  |- harness/          @ai-sdk-tool/harness — core loop, session, skills, TODO, commands
|  |  |- src/           Agent, MessageHistory, SessionManager, SkillsEngine, TodoContinuation
|  |  `- AGENTS.md      (see packages/harness/src for local guidance)
|  |- tui/              @ai-sdk-tool/tui — terminal UI components
|  |  |- src/           createAgentTUI, AssistantStreamView, BaseToolCallView, Spinner, colors
|  |  `- AGENTS.md      TUI package conventions
|  |- headless/         @ai-sdk-tool/headless — JSONL event streaming
|  |  |- src/           runHeadless, emitEvent, registerSignalHandlers, event types
|  |  `- AGENTS.md      Headless package conventions
|  `- cea/              @ai-sdk-tool/cea — code editing agent (uses all 3 packages)
|     |- src/
|     |  |- entrypoints/ CLI (interactive) + headless (JSONL) runtimes
|     |  |- tools/       edit_file, write_file, read_file, grep, glob, shell_execute
|     |  `- interaction/ stream rendering, spinner
|     `- benchmark/      Harbor terminal-bench adapter
|- scripts/             Benchmark and test automation
`- package.json         Workspace root — canonical scripts
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Interactive TUI entrypoint | `packages/tui/src/agent-tui.ts` | `createAgentTUI` — full terminal session loop |
| Headless JSONL runner | `packages/headless/src/runner.ts` | `runHeadless` — event-streaming loop |
| Core agent loop | `packages/harness/src/loop.ts` | `runAgentLoop` — model-agnostic iteration |
| Agent factory | `packages/harness/src/agent.ts` | `createAgent` — wraps Vercel AI SDK `streamText` |
| Message history | `packages/harness/src/message-history.ts` | `MessageHistory` — compaction + limit enforcement |
| Session management | `packages/harness/src/session.ts` | `SessionManager` — UUID-based session IDs |
| Skills loading | `packages/harness/src/skills.ts` | `SkillsEngine` — bundled/global/project skill discovery |
| TODO continuation | `packages/harness/src/todo-continuation.ts` | `TodoContinuation` — incomplete-task reminder loop |
| Command registry | `packages/harness/src/commands.ts` | `registerCommand`, `executeCommand`, `configureCommandRegistry` |
| Middleware chain | `packages/harness/src/middleware.ts` | `buildMiddlewareChain`, `MiddlewareConfig` |
| Stream rendering | `packages/tui/src/stream-handlers.ts` | `STREAM_HANDLERS` — per-part-type render dispatch |
| Tool call view | `packages/tui/src/tool-call-view.ts` | `BaseToolCallView`, `ToolRendererMap` |
| JSONL event types | `packages/headless/src/types.ts` | `TrajectoryEvent` union type |
| Signal handlers | `packages/headless/src/signals.ts` | `registerSignalHandlers` — SIGINT/SIGTERM/etc. |
| CEA tools | `packages/cea/src/tools/` | File edit, explore, shell execution tools |
| Benchmark adapter | `packages/cea/benchmark/AGENTS.md` | Trajectory conversion and validation constraints |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `createAgentTUI` | function | `packages/tui/src/agent-tui.ts` | Full interactive TUI session — input loop, stream rendering, command dispatch |
| `runHeadless` | function | `packages/headless/src/runner.ts` | JSONL event-streaming loop with optional TODO continuation |
| `runAgentLoop` | function | `packages/harness/src/loop.ts` | Model-agnostic agent iteration loop |
| `createAgent` | function | `packages/harness/src/agent.ts` | Wraps Vercel AI SDK `streamText` into an `Agent` |
| `MessageHistory` | class | `packages/harness/src/message-history.ts` | Conversation history with compaction and limit enforcement |
| `SessionManager` | class | `packages/harness/src/session.ts` | UUID-based session ID lifecycle |
| `SkillsEngine` | class | `packages/harness/src/skills.ts` | Discovers and loads skills from bundled/global/project dirs |
| `TodoContinuation` | class | `packages/harness/src/todo-continuation.ts` | Reads todo files and generates reminder messages |
| `shouldContinueManualToolLoop` | fn | `packages/harness/src/tool-loop-control.ts` | Shared continuation gate — returns `true` for `"tool-calls"` finish reason |
| `emitEvent` | function | `packages/headless/src/emit.ts` | Writes a `TrajectoryEvent` as a JSONL line to stdout |
| `registerSignalHandlers` | function | `packages/headless/src/signals.ts` | Registers SIGINT/SIGTERM/SIGHUP/SIGQUIT/uncaughtException handlers |
| `AssistantStreamView` | class | `packages/tui/src/stream-views.ts` | Renders streaming assistant text and reasoning in the TUI |
| `BaseToolCallView` | class | `packages/tui/src/tool-call-view.ts` | Renders tool call input/output in the TUI |

## CONVENTIONS

- Runtime and scripts are Bun-first (`packageManager: bun@1.2.x`); prefer `bun run <script>` over ad-hoc `npm exec`.
- Canonical quality flow is `check` (non-mutating) and `lint` (mutating via `ultracite fix`).
- Tests are colocated in `packages/harness/src/**` as `*.test.ts` and executed with `bun test`.
- `tsconfig.json` enforces `strict` in each package; do not treat `dist/` as source-of-truth.
- Legacy code should always be fully deprecated; aggressive updates without backward-compatibility guarantees are acceptable.
- Package build order: `harness` then `tui` and `headless` (both depend on harness), then `cea` (depends on all three).

## ANTI-PATTERNS (THIS PROJECT)

- Editing generated outputs (`dist/`, `packages/*/dist/`) as if they were source code.
- Using shell commands (`cat`, `sed`, `rm`, `find`, `grep`) for file operations that dedicated tools already cover.
- Stopping at planning/todo updates without executing the concrete actions.
- For benchmark work: changing event types without updating trajectory conversion rules in `packages/cea/benchmark/harbor_agent.py`.
- Importing from `@ai-sdk-tool/cea` inside `harness`, `tui`, or `headless` — dependency direction is one-way.

## UNIQUE STYLES

- File edits in CEA favor hashline-aware operations (`LINE#HASH` + `expected_file_hash`) for stale-safe modifications.
- Manual tool-loop continuation is intentionally constrained to finish reasons `tool-calls` and `unknown`.
- Headless mode emits structured JSONL event types (`user`, `tool_call`, `tool_result`, `assistant`, `error`) consumed by benchmark tooling.
- `SkillsEngine` discovers skills from up to five directories: bundled, global skills, global commands, project skills, project commands.

## COMMANDS

```bash
# From workspace root
bun install
bun run build          # Build all packages in dependency order
bun run typecheck      # Type-check all packages
bun run check          # Lint — non-mutating
bun run lint           # Lint — auto-fix
bun run test           # Run all tests

# CEA-specific (from packages/cea or via workspace scripts)
bun run start          # Interactive TUI
bun run headless -- --prompt "<task>"   # Headless JSONL mode
```

## NOTES

- Root rules are global. See `packages/tui/AGENTS.md` and `packages/headless/AGENTS.md` for package-local guidance.
- `packages/cea/benchmark/AGENTS.md` is intentionally specialized and should remain benchmark-focused.
- The `harness` package has no AGENTS.md of its own — its conventions are captured here and in the README.
