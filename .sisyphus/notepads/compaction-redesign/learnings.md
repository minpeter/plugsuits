# Learnings

## 2026-03-24 Session Start

### Codebase State
- 521 tests passing (512 harness + 9 headless)
- No CheckpointHistory, SessionStore, or compaction-types.ts yet (to be created)
- Pre-existing LSP errors in loop.test.ts and compaction-e2e.test.ts (not our concern)
- Working directly in main repo (no worktree) on branch `feat/compact-ultra`

### Key Architecture Facts (from explore)
- `message-history.ts:849` — `class MessageHistory` constructor
- `message-history.ts:112` — `extractMessageText()` function  
- `message-history.ts:76-110` — `estimateTokens()` function (CJK-aware)
- `tool-pruning.ts` — `extractMessageText` also duplicated here
- `compaction-policy.ts:84 lines` — shouldStartSpeculativeCompaction, needsCompactionFromUsage, isAtHardContextLimitFromUsage, getRecommendedMaxOutputTokens
- `compaction-planner.ts:72 lines` — calculateCompactionSplitIndex with tool-pair safety
- `compaction-prompts.ts:334 lines` — createModelSummarizer, DEFAULT_COMPACTION_USER_PROMPT
- `compaction-orchestrator.ts:351 lines` — speculative/blocking compaction lifecycle
- Consumer: `packages/cea/src/entrypoints/main.ts:174` — `new MessageHistory()` (THE instantiation site)
- Consumer: `packages/cea/src/agent.ts:419` — `maxTokens: contextLength` compaction config
- Test runner: `pnpm test` from root, `vitest run src` per package

### Conventions
- Test files: colocated `*.test.ts` in src/
- Mock style: factory functions (createMockAgent), no external mock libs
- Import style: named imports from `@ai-sdk-tool/harness`
- All packages use TypeScript strict mode

## Task T1: Extract Token Utils (Completed)

**What was done:**
1. Created `packages/harness/src/token-utils.ts` with:
   - `estimateTokens(text: string): number` - CJK-aware token estimation
   - `extractMessageText(message: ModelMessage): string` - text extraction from messages
   - Constants: `LATIN_CHARS_PER_TOKEN`, `CJK_CHARS_PER_TOKEN`

2. Created `packages/harness/src/token-utils.test.ts` with basic unit tests

3. Updated imports across the codebase:
   - `message-history.ts` - added import, removed duplicate functions
   - `tool-pruning.ts` - removed duplicate `extractMessageText`, added import
   - `compaction-orchestrator.ts` - changed import source to `token-utils`
   - `compaction-prompts.ts` - changed import source to `token-utils`
   - `index.ts` - moved `estimateTokens` export from message-history to token-utils

4. Removed unused constants from `message-history.ts`:
   - `LATIN_CHARS_PER_TOKEN`
   - `CJK_CHARS_PER_TOKEN`
   - `CJK_REGEX`

**Results:**
- ✅ All 521 existing tests pass (208 in harness + 8 in tui + 512 in plugsuits + 9 in headless)
- ✅ New token-utils.test.ts with 4 passing tests
- ✅ Zero LSP errors in harness package
- ✅ Commit: `4d2a555` - "feat(harness): extract and stabilize token estimation utilities"

**Key learning:**
When extracting utilities, check ALL import sites - even indirect ones through `compaction-orchestrator.ts` that import from the original location. Use grep/lsp to find all references before removing exports.

## Task T2: SessionStore JSONL Persistence (Completed)

**What was done:**
1. Added `packages/harness/src/session-store.test.ts` with TDD coverage for:
   - non-existent session returns null
   - 10-message write/read round-trip
   - checkpoint persistence
   - truncated last-line corruption tolerance
   - latest checkpoint precedence
2. Implemented `packages/harness/src/session-store.ts`:
   - JSONL append using `appendFileSync`
   - automatic header bootstrap (`type: "header"`)
   - checkpoint append (`type: "checkpoint"`)
   - full file load via `readFileSync` + line split + per-line parse
   - invalid/truncated line skip behavior during load
3. Exported `SessionStore` and `SessionData` from `packages/harness/src/index.ts`.

**Results:**
- ✅ `src/session-store.test.ts` passing (5 tests)
- ✅ Full monorepo `pnpm test` passing
- ✅ LSP diagnostics clean on changed files

**Key learning:**
- JSONL session logs can stay crash-tolerant with immediate append semantics if the reader treats each line as independently parseable and skips malformed trailing entries.

## Task T4: CheckpointHistory Core (Completed)

**What was done:**
1. Added `packages/harness/src/checkpoint-history.test.ts` first (TDD) with coverage for:
   - `addUserMessage` metadata/id/originalContent
   - `addModelMessages` return shape
   - insertion order (`getAll`)
   - conversion (`toModelMessages`, `getMessagesForLLM`)
   - tool-call/tool-result sequence sanitization
   - JSONL persistence with `SessionStore`
2. Implemented `packages/harness/src/checkpoint-history.ts`:
   - in-memory append-only `CheckpointMessage[]`
   - optional `SessionStore` append persistence
   - `ensureValidToolSequence` ported from `message-history.ts` safety logic
   - config normalization for compaction/pruning defaults
3. Exported `CheckpointHistory` / `CheckpointHistoryOptions` from `packages/harness/src/index.ts`.
4. Fixed a compile-time generic mismatch in `compaction-planner.ts` by making `calculateCompactionSplitIndex` generic again (keeps compatibility with `MessageHistory` message type).

**Results:**
- ✅ New `checkpoint-history.test.ts` passing (12 tests)
- ✅ Full monorepo `pnpm test` passing
- ✅ LSP diagnostics clean on changed files

**Key learning:**
- Tool sequence validation should run against the combined history (`existing + new`) to avoid dropping valid cross-batch tool-result messages.

## T4: Adapt compaction-policy.ts to use new CompactionConfig

**Status**: ✅ COMPLETED

### What was done:
1. Added import of `CompactionConfig` from `./compaction-types` to `compaction-policy.ts`
2. Implemented new function `shouldCompactFromContextOverflow(error: unknown): boolean` that detects context length exceeded errors across multiple error message patterns:
   - "context_length_exceeded"
   - "context length exceeded"
   - "context window"
   - "maximum context"
   - "too many tokens"
   - "input is too long"
   - "prompt is too long"
   - "tokens exceeds"
   - "token limit"
3. Added comprehensive test coverage with 7 test cases for the new function
4. Exported the new function from `index.ts`

### Key learnings:
- The import statement from `compaction-types` may need special handling — `Edit` tool had issues adding it initially
- Writing the entire file directly via `Write` tool was more reliable than trying to use `Edit` for adding imports
- The existing 4 functions (`shouldStartSpeculativeCompaction`, `needsCompactionFromUsage`, `isAtHardContextLimitFromUsage`, `getRecommendedMaxOutputTokens`) were preserved without behavior changes
- Error pattern matching must be case-insensitive (using `.toLowerCase()`) to catch various provider error message formats
- Test suite runs successfully; 12 tests pass for compaction-policy.test.ts

### Commit:
```
feat(harness): adapt compaction policy for checkpoint model
```
Files: compaction-policy.ts, compaction-policy.test.ts, index.ts

## 2026-03-24 Task T14 follow-up: headless stale-refire fix

- `CompactionOrchestrator.blockAtHardLimit()` must treat legacy history mocks as valid history arguments.
- Using only `isHistoryLike` for overload parsing silently dropped the passed history when `compact/getCompactionConfig/getEstimatedTokens` were absent.
- For backward compatibility with existing headless tests/runner usage, overload parsing should accept both:
  - checkpoint-like history (`compact/getCompactionConfig/getEstimatedTokens`)
  - legacy speculative history (`prepareSpeculativeCompaction/applyPreparedCompaction/isAtHardContextLimit`)
- Fixing this restored the stale speculative re-fire path in `runner.test.ts` without changing headless behavior contracts.
