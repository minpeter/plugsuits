# SOURCE KNOWLEDGE BASE

**Generated:** 2026-02-23 14:40 KST
**Scope:** `src/**`

## OVERVIEW
`src/` contains the runtime implementation for CLI/headless execution, tool orchestration, interaction rendering, and session middleware.

## STRUCTURE
```text
src/
|- entrypoints/      # CLI and headless runtime loops
|  `- AGENTS.md      # Entry-point-specific invariants
|- interaction/      # Stream rendering and continuation controls
|- tools/            # Tool implementations and registration
|  |- AGENTS.md      # Tool subsystem overview
|  `- modify/
|     `- AGENTS.md   # File mutation invariants and failure modes
|- commands/         # Slash command implementations
|- context/          # Session, history, skills, and prompt assembly
|- middleware/       # Cross-turn behavior (todo continuation, routing)
|- skills/           # Built-in skill content and metadata
|- agent.ts          # Agent manager and stream setup boundary
`- index.ts          # CLI bootstrap entrypoint
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Follow interactive/headless runtime lifecycle | `src/entrypoints/main.ts` | `runAgentLoop`/TUI/headless wiring live here |
| Follow headless JSON event emission | `src/entrypoints/main.ts` | Headless delegates to `@ai-sdk-tool/headless` and emits ATIF lifecycle events (`metadata/step/approval/compaction/error/interrupt`) |
| Change loop continuation policy | `../harness/src/tool-loop-control.ts` | Shared continuation predicate comes from harness |
| Adjust provider/model behavior | `src/agent.ts` | `AgentManager` owns stream setup and options |
| Modify slash command wiring | `src/commands/index.ts` | Keep aliases and command metadata aligned |
| Update auto-todo behavior | `src/middleware/todo-continuation.ts` | Drives cross-turn completion reminders |

## CONVENTIONS
- Keep runtime parity between interactive and headless execution paths in `entrypoints/main.ts` and the shared harness/headless packages.
- Keep tests colocated with source (`*.test.ts` beside implementation); this repo does not use a separate test directory.
- Prefer shared helpers from `@ai-sdk-tool/harness` for cross-runtime policies instead of duplicating literals.
- Treat `src/index.ts` as bootstrap-only; avoid placing runtime logic there.
- If a change alters event semantics in headless mode, verify benchmark compatibility via `benchmark/AGENTS.md` rules.

## ANTI-PATTERNS
- Adding runtime behavior only in one entrypoint when it should apply to both CLI and headless.
- Duplicating finish-reason continuation logic instead of reusing `shouldContinueManualToolLoop`.
- Introducing new command flows without corresponding tests in `src/**.test.ts`.
- Treating `src/tui/` as active runtime code without first adding real modules (currently an empty boundary).

## NOTES
- For entrypoint-specific constraints, see `src/entrypoints/AGENTS.md`.
- For tool subsystem and file mutation constraints, see `src/tools/AGENTS.md` and `src/tools/modify/AGENTS.md`.
