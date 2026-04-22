---
"@ai-sdk-tool/tui": patch
"@plugsuits/minimal-agent": patch
"plugsuits": patch
---

Bump outdated dependencies to their latest releases: `@ai-sdk-tool/parser` 4.1.21, `vitest` 4.1.5, and `@mariozechner/pi-tui` 0.68.1. Align the `@ai-sdk-tool/tui` peer range for `@mariozechner/pi-tui` to `^0.68.1` and update `createAliasAwareAutocompleteProvider` to the new async autocomplete API (`getSuggestions` now returns a `Promise<AutocompleteSuggestions | null>` and accepts the `{ signal, force? }` options object).
