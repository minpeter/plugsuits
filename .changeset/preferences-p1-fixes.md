---
"@ai-sdk-tool/harness": patch
"plugsuits": patch
"@plugsuits/minimal-agent": patch
---

Harden the user-preferences persistence layer against failure and concurrency, discovered during manual QA of PR #119 and flagged by the Oracle reviewer.

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
