# ENTRYPOINTS KNOWLEDGE BASE

**Generated:** 2026-02-23 14:40 KST
**Scope:** `src/entrypoints/**`

## OVERVIEW
`entrypoints/` defines the runtime front door in `main.ts`, which wires both interactive TUI and headless JSON event execution.

## STRUCTURE
```text
src/entrypoints/
`- main.ts                 # Interactive TUI + headless runtime wiring
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Follow interactive session lifecycle | `src/entrypoints/main.ts` | Interactive TUI wiring and input flow |
| Follow machine-readable run output | `src/entrypoints/main.ts` | Delegates to `@ai-sdk-tool/headless` ATIF lifecycle emission |
| Change continuation criteria | `../../harness/src/tool-loop-control.ts` | Shared stop/continue policy |
| Validate benchmark compatibility | `benchmark/AGENTS.md` | Headless event shape is consumed downstream |

## CONVENTIONS
- Keep interactive and headless continuation policy aligned via harness `shouldContinueManualToolLoop`.
- Treat `MANUAL_TOOL_LOOP_MAX_STEPS` as a safety contract, not a style preference.
- Keep signal/cleanup handling consistent across both entrypoints (`SIGINT`, `SIGTERM`, etc.).
- For event schema changes in headless mode, verify benchmark contract and validation flows.

## ANTI-PATTERNS
- Changing finish-reason loop behavior in one entrypoint only.
- Emitting new or modified headless event fields without benchmark alignment checks.
- Moving shared loop constants into per-entrypoint literals.
