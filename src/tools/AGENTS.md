# TOOLS SUBSYSTEM KNOWLEDGE BASE

**Generated:** 2026-02-23 14:40 KST
**Scope:** `src/tools/**`

## OVERVIEW
`src/tools/` implements all callable tools and maps stable public tool keys to concrete executors.

## STRUCTURE
```text
src/tools/
|- index.ts              # Public tool registry keys
|- execute/              # Shell execution and process management
|- explore/              # Read, glob, grep, and safety checks
|- modify/               # Deterministic file mutation operations
|  `- AGENTS.md          # High-risk mutation constraints
`- planning/             # Skill loading and todo state updates
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add or rename a tool key | `src/tools/index.ts` | Keep key names stable for model/tool contracts |
| Shell execution semantics | `src/tools/execute/shell-execute.ts` | Timeout, background handling, non-interactive wrapping |
| File read/search behavior | `src/tools/explore/read-file.ts` | Enforces limits and safe read semantics |
| Deterministic file editing | `src/tools/modify/edit-file.ts` | Hashline-native edits |
| Todo persistence semantics | `src/tools/planning/todo-write.ts` | Status accounting and validation |
| Skill content resolution | `src/tools/planning/load-skill.ts` | Local/project/bundled skill lookup behavior |

## CONVENTIONS
- `index.ts` is the single source of truth for exported tool key names (`shell_execute`, `read_file`, `edit_file`, etc.).
- Keep per-tool description files (`<tool-name>.txt`) synchronized with implementation and prompt wiring.
- Prefer dedicated `explore/modify` tools for file operations; shell is for build/test/git/system operations.
- `modify/edit-file.ts` is hashline-first: preserve `expected_file_hash` checks and deterministic anchors.
- New tool behavior must ship with colocated tests under the same subdirectory.

## ANTI-PATTERNS
- Introducing file reads/writes through shell commands when dedicated tools already exist.
- Changing tool key strings in `index.ts` without coordinated updates to callers and tests.
- Bypassing stale-safety checks in edit flows (`expected_file_hash`, anchored operations).
- Expanding planning behavior without updating validation and summary outputs in tests.

## NOTES
- `src/tools/modify/AGENTS.md` is the source of truth for hashline/legacy-edit constraints.
