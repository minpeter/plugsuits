# Runtime API Migration Roadmap

This document outlines how CEA can progressively adopt the `defineAgent + createAgentRuntime + AgentSession` runtime layer introduced in `@ai-sdk-tool/harness/runtime`.

## Phase 1: Session Lifecycle (Immediate — pure refactor, no behavior change)

Replace CEA's manual session management functions with runtime API equivalents. Zero behavior change, fewer lines.

| Current CEA function (`main.ts:499-538`) | Runtime API equivalent |
|---|---|
| `loadHistoryForSession(sessionId)` | `runtime.resumeSession({ sessionId })` |
| `replaceCurrentSessionHistory(id)` | `session.reload()` |
| `saveCurrentSessionSnapshot()` | `session.save()` |
| `applyCurrentSessionToRuntime()` | `session.save()` + `session.reload()` |

**Before:**
```typescript
const loadHistoryForSession = async (sessionId) => {
  agentManager.setMemoryStore(createSessionMemoryStore(sessionId), ...);
  return CheckpointHistory.fromSnapshot(store, sessionId, { compaction, pruning });
};
const replaceCurrentSessionHistory = async (sessionId) => {
  const restored = await loadHistoryForSession(sessionId);
  messageHistory.resetForSession(sessionId);
  messageHistory.restoreFromSnapshot(restored.snapshot());
};
const saveCurrentSessionSnapshot = async () => {
  await store.save(sessionId, messageHistory.snapshot());
};
```

**After:**
```typescript
const session = await runtime.resumeSession({ sessionId });
await session.save();    // replaces saveCurrentSessionSnapshot
await session.reload();  // replaces replaceCurrentSessionHistory
```

Estimated reduction: ~40 lines from `main.ts`.

## Phase 2: Partial Adoption (Medium effort, selective)

### onTurnComplete
Move the generic save to runtime (already handled by `autoSave`). Keep CEA-specific side effects (`trackReadFileRestorationItems`, `_memoryExtractor`) in a `defineAgent.onTurnComplete` hook.

### Command registration
Generic commands that don't depend on `AgentManager` state can be declared in `defineAgent.commands`. Commands that call `agentManager.buildCompactionConfig()` or `updateCompactionForCurrentModel()` must remain in CEA.

### Skill loading
Replace `await loadAllSkills()` in TUI mode with `defineAgent.skills` config if directories are statically known.

Estimated additional reduction: ~60-80 lines.

## Phase 3: Keep CEA-Specific (Do NOT migrate)

These are tightly coupled to Anthropic's API or CEA's UX and must remain CEA-specific:

- **`AgentManager` class** — Anthropic model building, thinking budget calculation, model switching via `/model` command. Cannot be replaced without losing provider-specific fidelity.
- **`buildModel()` / `buildCompactionConfig()`** — Requires a live Anthropic model instance.
- **TUI selector overlays** — Interactive model/reasoning/tool-fallback selector UIs. Pure CEA UX.
- **`buildAgentStreamWithTodoContinuation()`** — Splices TODO reminder messages into the stream. CEA-specific loop control.
- **`PostCompactRestorer`** — Tracks `read_file` results and rebuilds restoration messages after compaction. File-editing context recovery.
- **MCP tool merging** — `MCPManager.init() + mergeMCPTools`. CEA manages complex multi-server setups.
- **Translation middleware** — Language detection and auto-translation. CEA-specific feature.

## Migration Order

1. **Phase 1 first** — Safe refactor. Identical observable behavior, cleaner code.
2. **Phase 2 selectively** — Evaluate each item. Skip if migration adds complexity rather than reducing it.
3. **Never Phase 3** — These are CEA's core differentiators, not generic glue.

## Estimated Total Impact

- Phase 1: ~40 lines removed from `main.ts`
- Phase 2: ~60-80 lines removed
- Combined: ~100-120 lines removed, remaining code is more readable and testable
