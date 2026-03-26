## [2026-03-09] Task: Task-1
- Replaced the conditional exit guard at the end of `run()` in `packages/cea/src/entrypoints/cli.ts` with an unconditional `process.exit(requestedProcessExitCode ?? 0);`.
- Typecheck command `bun run typecheck --filter @ai-sdk-tool/cea` fails in this environment due missing dependency type declarations (`ai`, `node`, `@mariozechner/pi-tui`, `@ai-sdk-tool/harness`); failure occurs in harness packages, unrelated to this one-line change.
- `requestSignalShutdown` already sets `requestedProcessExitCode = code;` before shutdown, so using `?? 0` preserves signal exit behavior and sets default `0` for normal termination.
