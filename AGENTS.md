# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-23 14:40 KST
**Commit:** 4671d67
**Branch:** main
**Mode:** update

## OVERVIEW
`code-editing-agent` is a Bun + TypeScript CLI agent with two runtime paths: interactive TUI (`cli.ts`) and JSONL event streaming (`headless.ts`).
Core source code lives in `src/`, benchmark integration lives in `benchmark/`, and run artifacts are persisted under `jobs/`.

## STRUCTURE
```text
code-editing-agent/
|- src/                 # Runtime code, tools, interaction, command handling
|  |- AGENTS.md         # Source-level conventions and navigation
|  |- entrypoints/
|  |  `- AGENTS.md      # Runtime front-door invariants (CLI/headless)
|  `- tools/
|     |- AGENTS.md      # Tool subsystem boundaries and rules
|     `- modify/
|        `- AGENTS.md   # High-risk file mutation constraints
|- benchmark/           # Harbor terminal-bench adapter (Python + templates)
|- jobs/                # Generated benchmark run artifacts (do not edit manually)
|- dist/                # TypeScript build output
|- package/dist/        # Published package artifacts
|- package.json         # Canonical scripts and toolchain entrypoints
`- bunfig.toml          # Bun test root (`src`)
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Interactive runtime loop | `src/entrypoints/cli.ts` | Input loop, command execution, stream lifecycle |
| Headless event pipeline | `src/entrypoints/headless.ts` | JSONL events for benchmark/verifier integration |
| Model/provider/tool orchestration | `src/agent.ts` | Agent manager, provider selection, stream setup |
| Tool registration map | `src/tools/index.ts` | Stable tool key names to implementations |
| Deterministic file editing | `src/tools/modify/edit-file.ts` | Hashline mode + legacy compatibility mode |
| Stream rendering behavior | `src/interaction/pi-tui-stream-renderer.ts` | Text/reasoning/tool output rendering |
| Benchmark adapter rules | `benchmark/AGENTS.md` | Trajectory conversion and validation constraints |

## CODE MAP
| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `run` | function | `src/entrypoints/cli.ts:1553` | n/a | Main interactive session loop |
| `processAgentResponse` | function | `src/entrypoints/cli.ts:1255` | n/a | Handles one stream turn and continuation |
| `shouldContinueManualToolLoop` | constant fn | `src/interaction/tool-loop-control.ts:5` | 9 | Shared continuation gate for CLI/headless |
| `executeEditFile` | function | `src/tools/modify/edit-file.ts:1042` | 32 | Primary file mutation entrypoint |
| `AgentManager` | class | `src/agent.ts:163` | 2 | Central manager for model, provider, and tool config |

## CONVENTIONS
- Runtime and scripts are Bun-first (`packageManager: bun@1.3.9`); prefer `bun run <script>` over ad-hoc `npm exec`.
- Canonical quality flow is `check` (non-mutating) and `lint` (mutating via `ultracite fix`).
- Tests are colocated in `src/**` as `*.test.ts` and executed with `bun test` (`bunfig.toml` test root is `src`).
- `tsconfig.json` enforces `strict` and builds from `src` to `dist`; do not treat `dist` as source-of-truth.
- Legacy code should always be fully deprecated, and aggressive updates without backward-compatibility guarantees are acceptable in this repository.

## ANTI-PATTERNS (THIS PROJECT)
- Editing generated outputs (`jobs/`, `dist/`, `package/dist/`) as if they were source code.
- Using shell commands (`cat`, `sed`, `rm`, `find`, `grep`) for file operations that dedicated tools already cover.
- Stopping at planning/todo updates without executing the concrete actions.
- For benchmark work: changing event types without updating trajectory conversion rules in `benchmark/harbor_agent.py`.

## UNIQUE STYLES
- File edits favor hashline-aware operations (`LINE#HASH` + `expected_file_hash`) for stale-safe modifications.
- Manual tool-loop continuation is intentionally constrained to finish reasons `tool-calls` and `unknown`.
- Headless mode emits structured event types (`user`, `tool_call`, `tool_result`, `assistant`, `error`) consumed by benchmark tooling.

## COMMANDS
```bash
bun install
bun run start
bun run headless -- --prompt "<task>"
bun run check
bun run lint
bun run typecheck
bun run test
bun run build
```

## NOTES
- Root rules are global; see `src/AGENTS.md`, `src/entrypoints/AGENTS.md`, `src/tools/AGENTS.md`, and `src/tools/modify/AGENTS.md` for local, non-duplicated guidance.
- `benchmark/AGENTS.md` is intentionally specialized and should remain benchmark-focused.
