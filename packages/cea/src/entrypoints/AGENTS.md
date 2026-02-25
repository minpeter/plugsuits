# ENTRYPOINTS KNOWLEDGE BASE

**Generated:** 2026-02-23 14:40 KST
**Scope:** `src/entrypoints/**`

## OVERVIEW
`entrypoints/` defines the two runtime front doors: interactive CLI (`cli.ts`) and headless JSON event mode (`headless.ts`).

## STRUCTURE
```text
src/entrypoints/
|- cli.ts                  # Interactive TUI loop and command flow
`- headless.ts             # JSONL event-emitting runtime for automation
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Follow interactive session lifecycle | `src/entrypoints/cli.ts` | `run` loop, input handling, stream processing |
| Follow machine-readable run output | `src/entrypoints/headless.ts` | Emits `user/tool_call/tool_result/assistant/error` |
| Change continuation criteria | `src/interaction/tool-loop-control.ts` | Shared stop/continue policy |
| Validate benchmark compatibility | `benchmark/AGENTS.md` | Headless event shape is consumed downstream |

## CONVENTIONS
- Keep CLI and headless continuation policy aligned via `shouldContinueManualToolLoop`.
- Treat `MANUAL_TOOL_LOOP_MAX_STEPS` as a safety contract, not a style preference.
- Keep signal/cleanup handling consistent across both entrypoints (`SIGINT`, `SIGTERM`, etc.).
- For event schema changes in headless mode, verify benchmark conversion/validation flows.

## ANTI-PATTERNS
- Changing finish-reason loop behavior in one entrypoint only.
- Emitting new or modified headless event fields without benchmark alignment checks.
- Moving shared loop constants into per-entrypoint literals.
