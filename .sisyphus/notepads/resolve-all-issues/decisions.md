
## [Task 9] Architecture Improvements — 2026-03-09
- Kept `export const agentManager = createAgentManager()` for backward compatibility and made `createAgentManager(options?)` the real instantiation path for fresh, isolated managers.
- Limited `CreateAgentManagerOptions` to the canonical Task 9 keys only: `friendliToken`, `anthropicApiKey`, `friendliBaseURL`, and `anthropicBaseURL`.
- Left `packages/cea/src/entrypoints/cli.ts` unchanged after inspection because there was no duplicate module-level SIGINT handler to remove.

## [Task 9] Architecture Improvements - 2026-03-09

- Kept `agentManager` as `export const agentManager = createAgentManager()` for backward compatibility and made the factory the canonical path for creating isolated manager instances.
- Left `packages/cea/src/entrypoints/cli.ts` unchanged because it already satisfies the accepted minimal signal-cleanup shape: no duplicate module-level `SIGINT` handler and `activeUiForSignals` is cleared in a `try/finally`.
- Added focused tests for factory instance independence, singleton compatibility, friendli-capable reset baseline, and anthropic-only reset baseline instead of broad refactors.

- [F4] Verified merged PR groups: [63,64,65,66,67,68,69,70,72] all MERGED (9/9).
