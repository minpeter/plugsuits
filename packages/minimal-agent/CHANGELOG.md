# @plugsuits/minimal-agent

## 0.2.10

### Patch Changes

- a6b8a5f: `FileSnapshotStore` now takes a top-level directory (e.g. `.plugsuits`, `.minimal-agent`) and manages its internal layout itself: session snapshots land in `<root>/sessions/*.jsonl`. The public `rootDir` / `sessionsDir` getters expose the resolved paths for consumers that want to co-locate related files (e.g. session memory).

  When the root directory lives inside a git worktree (detected by a sibling `.git` marker, directory or file), the store appends the top-level directory to that worktree's `.gitignore` if not already listed. The update is concurrency-safe: an exclusive `.gitignore.lock` (via `openSync(path, "wx")`) serializes writers, and the content swap is atomic (temp-file + rename). Stale locks older than 30s are reclaimed so a crashed writer can't wedge the next caller. The file's existing line-ending convention is preserved (LF or CRLF), and the helper refuses to write to any ancestor `.gitignore` that is not at a verified worktree root — so it cannot accidentally modify a parent repo's or a user's home-level ignore file. Disable with `new FileSnapshotStore(dir, { autoGitignore: false })`.

  Env var migrations (no backward compatibility):

  - `minimal-agent`: `SESSION_DIR` → `MINIMAL_AGENT_DIR` (default `.minimal-agent`)
  - `tgbot`: `SESSION_DIR` → `TGBOT_DIR` (default `<tmpdir>/tgbot`)

  CEA now constructs its store with `.plugsuits` as the top-level directory and derives its session-memory path from `store.sessionsDir`.

  The previously-undocumented `getFilePath` fallback for unencoded session filenames has been removed; session files always live at `<sessionsDir>/<encodeSessionId(sessionId)>.jsonl`.

- Updated dependencies [a6b8a5f]
- Updated dependencies [c40f690]
- Updated dependencies [54125d0]
  - @ai-sdk-tool/harness@1.3.3
  - @ai-sdk-tool/headless@3.1.1
  - @ai-sdk-tool/tui@3.1.1

## 0.2.9

### Patch Changes

- 5bb3997: Update direct and transitive dependency resolutions across the monorepo, including AI SDK packages, tooling, TypeScript, and runtime adapters. Raise the declared Node.js support floor to 22.19.0 to match upgraded runtime dependencies such as undici 8.
- 8b1919c: Persist user-level agent preferences across sessions (e.g. `/translate`, `/reasoning-mode`, `/tool-fallback` in CEA; `/reasoning` in minimal-agent) so toggles set in the TUI survive process restarts.

  - Harness: new generic `PreferencesStore<T>` abstraction with `FilePreferencesStore` (single atomic JSON document), `InMemoryPreferencesStore`, `LayeredPreferencesStore` (configurable merge + write layer), and `shallowMergePreferences` helper. Exposed from the package root and a new `@ai-sdk-tool/harness/preferences` subpath. Intentionally separate from `SnapshotStore` because preferences are app/user-scoped while snapshots are session-scoped.
  - Harness: new one-line helper `createLayeredPreferences({ appName, validate })` that returns `{ store, userStore, workspaceStore, patch, paths }` backed by `~/.${appName}/settings.json` (user layer) and `./.${appName}/settings.json` (workspace layer, write target). `patch(partial)` handles the load-merge-save flow on the workspace layer so consumers don't have to reimplement it. Fully customizable paths, merge strategy, and validator — but the common case is now a single call.
  - Harness: new `createTogglePreferenceCommand` and `createEnumPreferenceCommand` factories that collapse the typical "parse args → validate → mutate runtime → persist" slash-command boilerplate into a declarative config object. Typed `field: keyof T` ensures persistence goes to the right preference key. Supports aliases, custom truthy/falsy words, custom parser, custom validator, and custom enabled/disabled messages.
  - CEA: `createUserPreferencesStore()` now delegates to `createLayeredPreferences` and also exposes the full harness bundle alongside the existing public fields. `/translate` is migrated to `createTogglePreferenceCommand`; the CEA-local `createToggleCommand` factory is deleted as dead code. `/translate` now awaits persistence (previously fire-and-forget), so the command response confirms the disk write.
  - CEA: `/reasoning-mode` and `/tool-fallback` continue to use the shared `preferences-persistence` singleton for now (they have domain-specific selectable-modes logic that is not a good fit for the generic factory yet). `configurePreferencesPersistence` now accepts an optional `bundle` argument so future migrations can reuse the harness factories.
  - CEA startup: persisted preferences are applied to `AgentManager` before CLI flags. Explicit CLI flags (`--no-translate`, `--reasoning-mode on`, `--tool-fallback`, `--toolcall-mode`) still win for the current process but no longer overwrite the persisted file — they are one-shot overrides only. `resolveSharedConfig` now accepts `rawArgs` so callers can distinguish explicit flags from defaults.
  - minimal-agent: gains a `/reasoning <on|off>` slash command that toggles `providerOptions.openai.reasoningEffort` via the `onBeforeTurn` hook and persists the value through `createLayeredPreferences`. The command definition is a single 10-line factory call thanks to `createTogglePreferenceCommand`. Header subtitle shows the live reasoning state. Preferences are stored at `~/.minimal-agent/settings.json` and `./.minimal-agent/settings.json` (separate from CEA so the two agents' defaults don't collide).

- 8b1919c: Harden the user-preferences persistence layer against failure and concurrency, discovered during manual QA of PR #119 and flagged by the Oracle reviewer.

  - Harness: `FilePreferencesStore.clear()` now deletes the file with `rmSync` instead of writing `"{}"`. Previously `clear()` left an empty `{}` on disk, and un-validated stores would return `{}` from `load()` instead of `null`, breaking the contract shared with `InMemoryPreferencesStore`. Consumers using a validator were unaffected in practice because empty objects already validated to `null`.
  - Harness: `createLayeredPreferences().patch()` now serializes calls through a promise queue. Previous implementation was a plain read-modify-write, so two concurrent `patch()` calls could both read the same stale workspace JSON and one update would be silently dropped. Concurrency tests cover both different-field and same-field writes.
  - Harness: `createTogglePreferenceCommand` and `createEnumPreferenceCommand` now **persist before mutating runtime**. If disk persistence fails, the runtime state is never touched and the command returns `{ success: false, message: "Failed to persist …" }`. If the runtime `set()` throws after a successful persist, the disk write is rolled back to the previous value. This eliminates the class of "disk and runtime disagree" bugs across all factory-backed commands.
  - CEA: `patchWorkspacePreferences` now queues writes per-store via a `WeakMap`-keyed promise chain, matching the harness bundle semantics. This protects the shim path used by `/reasoning-mode` and `/tool-fallback` from the same lost-update race that previously affected the factory path.
  - CEA: `applyPersistedPreferencesToAgentManager` and `applySharedConfigToAgentManager` extracted from `main.ts` into `packages/cea/src/entrypoints/preferences-startup.ts`. Now pure functions taking the agent manager and store as arguments, so startup wiring is testable in isolation. Existing `main.ts` call sites updated to pass dependencies explicitly.
  - CEA: minimal-agent gains `vitest` devDep, `test` script, `vitest.config.ts`, and excludes `*.test.ts` / `vitest.config.ts` from the TypeScript build output. `citty` was a dead devDependency — removed.
  - Tests added:
    - Harness `preferences-store.test.ts`: `clear()` ⇒ `load()` null, `clear()` removes file on disk, `clear()` no-op on missing file, cross-instance restart, three concurrent-patch scenarios (different fields, same field, queue recovery after failure).
    - Harness `preference-commands.test.ts`: persist-first contract — toggle + enum commands do NOT mutate runtime when persistence fails, toggle command rolls back disk when runtime set throws, toggle command returns success only when BOTH disk and runtime succeed.
    - CEA `user-preferences.test.ts`: concurrent `patchWorkspacePreferences` preserves all fields, same-field is last-writer-wins, save errors bubble to caller.
    - CEA `preferences-persistence.test.ts` (new): singleton lifecycle, custom `onError` handler fires on save failure, concurrent `persistPreferencePatch` preserves all fields.
    - CEA `reasoning-mode.test.ts` (new): 7 tests covering status report, valid transitions, invalid mode rejection, persistence, sibling field preservation, no-op "already using", graceful behavior without persistence configured.
    - CEA `tool-fallback.test.ts` (new): 7 tests in the same shape.
    - CEA `preferences-startup.test.ts` (new): integration tests for `applyPersistedPreferencesToAgentManager` and `applySharedConfigToAgentManager` covering all three fields, CLI-vs-persisted precedence, and the invariant that CLI flags never write to the store.
    - minimal-agent `preferences.test.ts` (new): 7 tests covering path expectations, schema validation, round-trip, and the `/reasoning` onBeforeTurn integration (toggle → closure mutation → providerOptions change).
  - Test counts:
    - Harness: 673 → 699 (+26)
    - CEA: 526 → 563 (+37)
    - minimal-agent: 0 → 7 (+7)
    - Total workspace: 1283 → 1353 (+70)

- f523de9: Bump outdated dependencies to their latest releases: `@ai-sdk-tool/parser` 4.1.21, `vitest` 4.1.5, and `@mariozechner/pi-tui` 0.68.1. Align the `@ai-sdk-tool/tui` peer range for `@mariozechner/pi-tui` to `^0.68.1` and update `createAliasAwareAutocompleteProvider` to the new async autocomplete API (`getSuggestions` now returns a `Promise<AutocompleteSuggestions | null>` and accepts the `{ signal, force? }` options object).
- 003dca1: Polish the TUI area around the prompt so transient status updates and tool-call startup no longer cause avoidable visual jumps.

  - Render the foreground loader through `FooterStatusBar` so `Processing...`, `Working...`, `Executing...`, and `Compacting...` share the footer row with context pressure instead of mounting a standalone status block near the editor.
  - Rename `CommandPreprocessHooks.statusContainer` to `overlayContainer`; CEA and minimal-agent now mount their slash-command selectors in that overlay container while clearing the footer loader first.
  - Make `BaseToolCallView` reserve visible space immediately with a `Preparing tool call…` pending indicator until real tool input arrives, avoiding a zero-height gap at tool-call start.
  - Tighten the `✓ New session started` banner spacing, remove the eager gray `⚡ Interrupted` message in favor of the final red interruption hint, and clear footer status when starting a new session.

- Updated dependencies [e937dc7]
- Updated dependencies [5bb3997]
- Updated dependencies [8b1919c]
- Updated dependencies [8b1919c]
- Updated dependencies [496ffdb]
- Updated dependencies [f523de9]
- Updated dependencies [88b7197]
- Updated dependencies [2a29da7]
- Updated dependencies [003dca1]
  - @ai-sdk-tool/harness@1.3.1
  - @ai-sdk-tool/headless@3.1.1
  - @ai-sdk-tool/tui@3.1.1

## 0.2.8

### Patch Changes

- Updated dependencies [a714664]
  - @ai-sdk-tool/harness@1.3.0
  - @ai-sdk-tool/tui@3.1.0
  - @ai-sdk-tool/headless@3.1.0

## 0.2.7

### Patch Changes

- Updated dependencies [5e0768c]
  - @ai-sdk-tool/harness@1.2.4
  - @ai-sdk-tool/tui@3.0.2
  - @ai-sdk-tool/headless@3.0.3

## 0.2.6

### Patch Changes

- Updated dependencies [f819d0c]
- Updated dependencies [bd8bd8a]
  - @ai-sdk-tool/headless@3.0.2
  - @ai-sdk-tool/harness@1.2.3
  - @ai-sdk-tool/tui@3.0.1

## 0.2.5

### Patch Changes

- 6ce5711: Add MCP (Model Context Protocol) client integration and improve developer experience

  - `createAgent()` now accepts an `mcp` option for automatic MCP tool loading
  - `createAgent()` is now async and returns `Promise<Agent>`
  - `Agent.close()` method added for MCP connection cleanup (no-op when no MCP configured)
  - `MCPOption` supports four forms: `true` (load from `.mcp.json`), `MCPServerConfig[]` (inline servers), `{ config, servers }` (both), or a pre-initialized `MCPManager` instance
  - MCPManager caching with reference counting — same config reuses existing connections
  - Inline server arrays (`MCPServerConfig[]`) now correctly passed to MCPManager
  - `MCPManagerOptions.servers` added for programmatic server injection
  - Minimal agent wired with DuckDuckGo search MCP server

- Updated dependencies [6ce5711]
  - @ai-sdk-tool/harness@1.2.2
  - @ai-sdk-tool/headless@3.0.1
  - @ai-sdk-tool/tui@3.0.1

## 0.2.4

### Patch Changes

- Updated dependencies [2f62589]
- Updated dependencies [2f62589]
  - @ai-sdk-tool/harness@1.2.1
  - @ai-sdk-tool/tui@3.0.1
  - @ai-sdk-tool/headless@3.0.1

## 0.2.3

### Patch Changes

- Updated dependencies [18bfebb]
  - @ai-sdk-tool/harness@1.2.0
  - @ai-sdk-tool/headless@3.0.0
  - @ai-sdk-tool/tui@3.0.0

## 0.2.2

### Patch Changes

- Updated dependencies [9ba8e20]
  - @ai-sdk-tool/harness@1.1.1
  - @ai-sdk-tool/headless@2.0.1
  - @ai-sdk-tool/tui@2.0.1

## 0.2.1

### Patch Changes

- Updated dependencies [5aaef15]
  - @ai-sdk-tool/headless@2.0.0
  - @ai-sdk-tool/tui@2.0.0

## 0.2.0

### Minor Changes

- 5a8b087: feat: decouple shared runtimes and simplify context footer text

  - split the shared harness, terminal UI, and headless runner into reusable workspace packages with expanded session, command, and compaction infrastructure
  - unify the `plugsuits` CLI around the shared runtimes, improve `/compact` behavior, and make file read failures more actionable
  - remove the `Context:` prefix from footer-style context usage displays so the TUI shows a cleaner token summary across agents

### Patch Changes

- Updated dependencies [badc5c7]
- Updated dependencies [5a8b087]
- Updated dependencies [618d458]
  - @ai-sdk-tool/harness@1.1.0
  - @ai-sdk-tool/tui@1.0.0
  - @ai-sdk-tool/headless@1.0.0
