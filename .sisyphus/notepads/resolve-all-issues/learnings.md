## [Wave 0] Baseline Recording
- bun test: 199 pass, 24 fail, 24 errors
- bun run typecheck: FAIL
- bun run check: FAIL
- #35 status: already resolved
- #41 status: already resolved
## [Wave 0] Baseline Recording - 2026-03-08

### Environment Setup
- Worktree requires `bun install` before typecheck works
- Without bun install: typecheck fails with "module not found" errors
- Always run `bun install` first in worktree before quality checks

### Test Baseline (after bun install)
- bun test: 495 pass, 5 fail, 5 errors (500 total, 39 files)
- bun run typecheck: PASS (harness + cea)
- bun run check (biome): FAIL with 25 errors, 3 warnings (PRE-EXISTING, not our issue)

### Issue Pre-verification
- #35: CLOSED - timeout_ms already exists in shell-execute.ts schema with DEFAULT_TIMEOUT_MS=120_000
- #41: CLOSED - 5 guards in FILE_WRITE_GUARDS: checkRootDirectoryGuard, checkPathTraversalSegmentsGuard, checkSensitivePathsGuard

### Key Constraint for Wave 1
- Pre-existing lint errors (25) are baseline - don't count them as regressions
- 5 pre-existing test failures - don't count as regressions
- typecheck must remain PASS after our changes
- tests must not drop below 495 pass, must not exceed 5 fail

### Monorepo Structure
- packages/harness: @ai-sdk-tool/harness (core agent loop)
- packages/cea: @ai-sdk-tool/cea (code editing agent)
- bun test runs: packages/harness/src + packages/cea/src

## [Task 1] PR Group 1: Env/Provider DX
- PR URL: https://github.com/minpeter/plugsuits/pull/63
- Branch: fix/env-provider-dx
- Issues closed: #36, #37, #42
- Changeset: .changeset/env-provider-dx.md
- Key learning: `validateProviderConfig()` was exported from `env.ts` itself (not a separate module) since both entrypoints already import from env.ts — minimized file count. All `dist/`-based test failures were pre-existing (shell-interact.txt missing) — src-only test run (475 pass, 0 fail) is the correct baseline for regressions. `z.string().url().optional()` pattern works cleanly for optional base URL fields. Conditional spread `...(env.FRIENDLI_BASE_URL ? { baseURL: env.FRIENDLI_BASE_URL } : {})` avoids passing undefined to provider constructors.

## [Task 2] PR Group 2: Security (Glob)
- PR URL: https://github.com/minpeter/plugsuits/pull/64
- Branch: fix/security-hardening
- Issue closed: #46
- Changeset: .changeset/security-hardening.md

### Key learnings:
- `Bun.Glob.scan()` follows symlinks by default — containment check requires calling `realpath()` on each matched path and verifying the resolved path starts with `canonicalSearchDir + sep`
- Canonicalize searchDir itself with `realpath()` before the loop (once), since the input path may also contain symlinks (e.g., macOS `/tmp -> /private/tmp`)
- Broken symlinks cause `realpath()` to throw ENOENT — catch and `continue` to skip silently
- Candidate count limit (10,000) must be checked BEFORE the realpath call to bound the total number of realpath() calls; otherwise unlimited symlink escapes could stall the loop
- For tests: `symlinkSync` works in user space on macOS; both directory symlinks and file symlinks can be tested with actual temp dirs
- Editing across multiple edit calls on the same file requires re-reading after each call — hash references become stale after any edit changes line counts (e.g., adding an import shifts all subsequent line numbers/hashes)
- When adding a new field to the output array (e.g., `glob_limit_reached:`), existing tests that check specific fields like `truncated: false` continue to pass as long as they use `toContain` not exact match

## [Task 3] PR Group 3: Process Safety
- PR URL: https://github.com/minpeter/plugsuits/pull/65
- Branch: fix/process-safety
- Issue closed: #51
- Key learning: Tracking pending SIGKILL timers per PID lets `finish()` cancel delayed kills safely, which prevents PID reuse races without changing detached process-group behavior.

## [Task 4] PR Group 4: Command Wrapping
- PR URL: https://github.com/minpeter/plugsuits/pull/66
- Branch: fix/command-wrapping
- Issue closed: #48

## [Task 5] PR Group 5: Session State
- PR URL: https://github.com/minpeter/plugsuits/pull/67
- Branch: fix/session-state
- Issues closed: #44, #49


## [Task 3] PR Group 3: Process Safety
- PR URL: https://github.com/minpeter/plugsuits/pull/65
- Branch: fix/process-safety
- Issue closed: #51

## [Task 6] PR Group 6: Headless Improvements
- PR URL: https://github.com/minpeter/plugsuits/pull/68
- Branch: fix/headless-improvements
- Issues closed: #34, #40, #45
- Key learning: When editing with the Edit tool and the replacement includes a closing brace `}` at the end of a range, auto-indentation may silently convert it to match the wrong scope level — always verify brace counts after edits by running typecheck immediately. Cherry-pick is the cleanest recovery when a commit lands on the wrong branch (just stash-track which branch you're on).  `preparedReminder.originalText` TypeScript error avoided by simply dropping the argument since `addUserMessage(content, originalContent?)` is optional.  `Promise.race` with a `setTimeout`-based rejection is the standard Bun/TS pattern for async timeouts without AbortController.

## [Task 7] PR Group 7/Group 8 in plan: Message History
- PR URL: https://github.com/minpeter/plugsuits/pull/69
- Branch: fix/message-history
- Issue closed: #39
- Key learning: `enforceLimit()` has three distinct exit paths that can produce orphaned tool results: (1) `maxMessages=1` early return where the last message is a tool result, (2) the no-turn-boundaries fallback slice, and (3) the final fallback `slice(-(maxMessages-1))`. All three need the cleanup call. The `ToolResultOutput` type in Vercel AI SDK is NOT a plain string — it's `{ type: 'text', value: string } | { type: 'json', value: JSONValue } | ...`. Tests must use `{ type: 'text' as const, value: '...' }` format. The fix also applies to `performCompaction()` since `messagesToKeep = this.messages.slice(splitIndex)` can start at a tool message if splitIndex lands mid-sequence.

---
## Task 9 Research — 2026-03-09

### 1. Singleton + Factory Backward Compatibility Pattern (TypeScript)

**Canonical pattern** (used by Vercel AI SDK itself — `@ai-sdk/anthropic`):
```typescript
// Factory function — creates fresh, independent instances
export function createAnthropic(options: AnthropicProviderSettings = {}): AnthropicProvider {
  // ... build and return new instance
}

// Default singleton — backward-compat export, calls factory with no args
export const anthropic = createAnthropic();
```
Source: https://github.com/vercel/ai/blob/a921fbb381cf2d19ef75ae27906f8d1cb0b8325b/packages/anthropic/src/anthropic-provider.ts#L90-L177

**Key invariants**:
- Factory function takes `options = {}` (default param) → zero-arg call always works
- Singleton is a `const` at module level, initialized once at import time
- Existing `import { agentManager } from './agent'` continues to work unchanged
- No breaking change to public API surface

**For Task 9 specifically** (`packages/cea/src/agent.ts`):
```typescript
// Add factory:
export function createAgentManager(options?: { friendliToken?: string; ... }): AgentManager {
  const friendliClient = options?.friendliToken ? createFriendli({ apiKey: options.friendliToken }) : friendli;
  const anthropicClient = options?.anthropicApiKey ? createAnthropic({ apiKey: options.anthropicApiKey }) : anthropic;
  return new AgentManager(friendliClient, anthropicClient);
}

// Keep singleton (backward compat):
export const agentManager = createAgentManager();
```
AgentManager constructor already accepts optional client params (lines 285-295 of agent.ts) — factory just wraps it.

### 2. Testing Independent Instances from Factory

**Pattern** (from `johnlindquist/mdflow` and `lgrammel/ai-sdk-llama-cpp`):
```typescript
describe("createAgentManager factory", () => {
  it("creates new AgentManager instance", () => {
    const manager = createAgentManager();
    expect(manager).toBeInstanceOf(AgentManager);
  });

  it("creates independent instances", () => {
    const m1 = createAgentManager();
    const m2 = createAgentManager();
    expect(m1).not.toBe(m2);  // reference inequality
  });

  it("singleton backward compatibility", () => {
    expect(agentManager).toBeInstanceOf(AgentManager);
    // singleton is NOT the same object as a freshly created one
    const fresh = createAgentManager();
    expect(fresh).not.toBe(agentManager);
  });

  it("independent state — setModelId on one does not affect other", () => {
    const m1 = createAgentManager();
    const m2 = createAgentManager();
    m1.setModelId("some-model");
    expect(m2.getModelId()).toBe(DEFAULT_MODEL_ID);  // unchanged
  });
});
```
Sources:
- https://github.com/johnlindquist/mdflow/blob/1185549564f1a17d9f11d23f72a66dfd1da1537d/src/runtime.test.ts#L328-L337
- https://github.com/lgrammel/ai-sdk-llama-cpp/blob/05645f09e9b6686780322fc42fb7d4fea20df4ea/packages/ai-sdk-llama-cpp/tests/unit/provider.test.ts#L127-L145

**Critical**: test state isolation via `resetForTesting()` in `beforeEach` already exists in `agent.test.ts` — keep using it for singleton tests.

### 3. CLI Signal Cleanup — try/finally Pattern

**Current state in cli.ts** (already partially correct):
- Lines 1801-1818: `try { while (!shouldExit) {...} } finally { activeUiForSignals = null; await ui.dispose(); }`
- The try/finally for `activeUiForSignals` is **already implemented** at lines 1813-1814

**What Task 9 actually needs** (#43):
- Remove duplicate `process.once("SIGINT")` at module level — grep shows `process.on("SIGINT", onSigInt)` at line 1223 (inside a function scope) and `process.off("SIGINT", onSigInt)` at 1266 — these are per-UI handlers, not module-level duplicates
- The `process.once("SIGTERM/SIGHUP/SIGQUIT")` at lines 1855-1865 are module-level one-time handlers (correct pattern)
- Need to verify: is there a bare `process.once("SIGINT")` at module level separate from the per-UI `process.on("SIGINT")`?

**Bun-specific**: Bun supports `process.on("SIGINT")` (Node.js compat). Official docs: https://bun.sh/docs/guides/process/os-signals
- Use `process.once()` for one-shot cleanup (module-level signals)
- Use `process.on()` + `process.off()` pair for per-session handlers (UI lifecycle)
- `try/finally` is the correct pattern for ensuring `activeUiForSignals = null` even on throw

**Pattern for minimal CLI cleanup**:
```typescript
// Module-level: one-shot signals (already correct in cli.ts)
process.once("SIGTERM", () => requestSignalShutdown(143));

// Per-UI: registered/deregistered with UI lifecycle
const onSigInt = () => { ... };
process.on("SIGINT", onSigInt);
try {
  // UI loop
} finally {
  process.off("SIGINT", onSigInt);
  activeUiForSignals = null;
}
```

### 4. Key Observation: AgentManager Constructor Already Supports Injection

`packages/cea/src/agent.ts` lines 285-295: constructor already accepts `friendliClient` and `anthropicClient` as optional params. The factory function just needs to:
1. Accept options object
2. Conditionally create fresh clients OR fall back to module-level singletons
3. Return `new AgentManager(friendliClient, anthropicClient)`

This means `resetForTesting()` can also be enhanced to reset provider clients by accepting new ones, or the factory pattern makes `resetForTesting()` less necessary for test isolation (just create a new instance).

## [Task 9] Architecture Improvements - 2026-03-09

- `createAgentManager(options?)` works best when it resolves env-backed defaults once, builds per-instance provider client factories, and passes those factories into `AgentManager` so `resetForTesting()` can recreate fresh clients instead of reusing stale injected instances.
- Supporting both `friendliBaseURL`/`anthropicBaseURL` and legacy camel-casing variants (`friendliBaseUrl`/`anthropicBaseUrl`) preserves compatibility while still matching the plan's explicit option names.
- `resetForTesting()` must restore the baseline provider from the instance's own available clients, not hardcode Friendli; anthropic-only managers should come back as provider=`anthropic` with `DEFAULT_ANTHROPIC_MODEL_ID`.
- `bun run check` still fails on pre-existing `packages/cea/src/friendli-models.ts` lint issues, while changed-file-only ultracite checks for `agent.ts`, `agent.test.ts`, and `.changeset/architecture.md` pass.

## [Task 9] Architecture Improvements — 2026-03-09
- `createAgentManager(options?)` must pass provider factories into `AgentManager`, not just prebuilt clients, otherwise `resetForTesting()` cannot reliably recreate per-instance provider baselines.
- `Object.hasOwn(options, key)` is the key pattern for provider config here because explicit `undefined` must disable env fallback (needed for anthropic-only instances like `{ friendliToken: undefined, anthropicApiKey: "..." }`).
- `packages/cea/src/entrypoints/cli.ts` already satisfies the SIGINT cleanup requirement: the only SIGINT handler there is the per-UI `process.on("SIGINT", onSigInt)` paired with `process.off(...)`; module-level handlers are for SIGTERM/SIGHUP/SIGQUIT only, so no CLI change was required.

- [F4] Open issues verified as 0 via `gh issue list --state open`; closed-with-PR check shows 15/17 for issue set [33,34,35,36,37,38,39,40,41,42,43,44,45,46,48,49,50,51], with #35 and #41 pre-closed before grouped-plan context.
