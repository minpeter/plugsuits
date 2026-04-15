# Issues — legacy-cleanup

## 2026-03-24

- Initial token-tracking test for `clear() resets summaryMessageId to null` failed because a single message did not always trigger compaction.
- Resolved by forcing compactable setup in test (`keepRecentTokens: 0` + 2 user messages) before asserting summary checkpoint exists.

- First full `pnpm test` run failed in `compaction-orchestrator.test.ts` (`shouldStartSpeculative()` false) after adding policy-based methods.
- Resolved by bounding speculative trigger limit with `min(activeContextLimit, compaction.maxTokens)` in `CheckpointHistory.shouldStartSpeculativeCompactionForNextTurn()`.

## 2026-04-15

- `lsp_diagnostics` was not usable for changed TS files because the underlying `biome` executable is missing from the environment.
- Mitigation: used passing `pnpm run build`, `pnpm run typecheck`, and `pnpm run test` as the verification gate for this wave.
