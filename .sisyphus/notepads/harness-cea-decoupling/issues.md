# Issues & Gotchas

## [2026-03-09] Initial Observations
- Bun workspace uses "packages/*" glob — tui and headless will be auto-picked up
- Root tsconfig.json is NOT a project references config (no "references" array) — needs careful update
- harness tsconfig.json excludes test files: "src/**/*.test.ts" — new packages should do same
- bunfig.toml controls test root (src dir) — need to verify test discovery for new packages

## [2026-03-11] Integration gotcha
- `lsp_diagnostics` for JSON (`packages/cea/package.json`) failed in this environment due to missing `biome` executable in PATH; used `bunx biome check` as file-level diagnostics fallback.
