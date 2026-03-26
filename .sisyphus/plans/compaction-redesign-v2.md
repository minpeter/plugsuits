# Compaction System Redesign v2 — Frontier-Informed Architecture

## TL;DR

> **Quick Summary**: 8개 프론티어 하네스 분석 결과, plugsuits는 이미 frontier 기능의 80%를 갖추고 있음. 문제는 구조가 아니라 threshold 타이밍 + 8k급 summarizer 예산 부족 + post-compaction headroom 부족. Metis 검증을 통해 "바닥부터 재설계"가 아닌 **진단 우선 + 수술적 수정** 접근으로 전환.
>
> **Deliverables**:
> - Redesigned compaction trigger policy (threshold-based, not estimation-based)
> - Progressive tool output pruning layer before summarization
> - Structured handoff summary with file tracking and task-state injection
> - Token re-baselining after compaction (actual usage reset)
> - Provider-specific overflow error detection
> - Comparison test framework at 8k/20k/40k/80k
> - Compaction behavior graph generation
>
> **Estimated Effort**: XL
> **Parallel Execution**: YES — 4 waves
> **Critical Path**: Policy → Pruning → Summary → Integration → Test

---

## Context

### Original Request
사용자가 8개 프론티어 하네스를 참고해 plugsuits compaction을 바닥부터 재설계하고, 8k/20k/40k/80k 에서 "코드베이스를 탐색하고, 이 코드 베이스에 대해서 설명해줘" 프롬프트로 테스트하여 그래프까지 그리기를 요청.

### Interview Summary
**Key Discussions**:
- 이전 작업에서 token estimation 수정, probe 추가, UI 분리까지 했으나 여전히 8k에서 overflow, 20k/40k에서 task completion 실패
- 사용자가 "기본구조를 근간부터 완전히 흔들어도 괜찮다"고 명시
- "최고의 DX를 만드는 것만이 목표"

### Frontier Harness Comparison Matrix

| Harness | Threshold | Pruning | Summary Style | Reserve | Re-baseline | Replay |
|---------|-----------|---------|---------------|---------|-------------|--------|
| **Codex** | Absolute token limit | Trim loop on error | Compressed transcript | Model-specific | `recompute_token_usage()` | Context re-inject |
| **Crush** | Dual-mode (20k fixed / 20% ratio) | None | Structured handoff (5 sections) | 20k or 20% | `PromptTokens=0` | Re-queue with intent prefix |
| **Gemini-CLI** | **50%** preemptive | Reverse-budget truncation (50k budget) | LLM + verification loop | Split 70/30 | Full recalculation | Continuation message |
| **Goose** | **80%** ratio | **Progressive middle-out** (0→10→20→50→100%) | LLM summary | Provider default | Session metadata | Preserved user message |
| **Kilocode** | `input_limit - reserved` | Soft-delete old tools (40k protect, 20k min savings) | Agent conversation (structured template) | min(20k, maxOutput) | Session reload | User message replay |
| **Oh-my-pi** | `contextWindow - max(15%, 16k)` | Tool output pruning (40k protect) | Context-full + file tracking + remote | max(15%, 16384) | Session reload | Auto-continue |
| **OpenCode** | Same as Kilocode (fork) | Same pruning | Same template | Same | Same | Same |
| **Pi-mono** | `contextWindow - reserveTokens(16k)` | Tool output pruning | Structured + split-turn dual summary | 16384 fixed | Session reload | Auto-retry |

### Metis Gap Analysis (Critical Reframing)

**Key finding**: plugsuits already implements threshold-based triggers (3 tiers), progressive tool pruning, model-based summarization with extractive fallback, speculative background compaction, user message replay, and token re-baselining. The system is **not primitive** — it has specific bottlenecks at small context windows.

**Root causes identified by Metis**:
1. **Summarizer budget starvation at 8k**: At 8k context, the summarizer has only ~3k tokens of input budget — barely enough to read the conversation, let alone produce a useful summary
2. **Threshold timing too late**: Speculative compaction at ~75% of soft budget means the window between "start compacting" and "hard limit" is too small for one large tool output to overshoot
3. **Post-compaction headroom insufficient**: Compaction reduces to ~80% of limit instead of ≤60%, leaving too little room for the next turn
4. **Compaction cooldown missing**: At 8k, rapid-fire compaction loops waste tokens

**Metis guardrails**:
- G1: Harness/CEA boundary — file tracking belongs in CEA summarizeFn, not harness
- G2: No multi-strategy conflation — pick ONE primary strategy per problem, not union of all 8
- G3: Summarizer must have independent budget (≥4k input + 2k output regardless of main limit)
- G4: Token estimation safety multiplier ≥1.15 for all threshold comparisons
- SC1: Max 15 overflow patterns (only configured providers), not 40+
- SC2: File tracking via CEA hook, not harness feature

### Targeted Improvements from Frontier Research

1. **Context-size-adaptive thresholds** — Earlier trigger at small windows (50% at 8k → 70% at 80k), inspired by Gemini/Crush dual-mode
2. **Extractive fallback priority at small contexts** — Skip model summarization when summarizer budget < 4k (from Gemini-CLI's fallback logic)
3. **Structured handoff summary** — Crush/Kilocode template for Goal/Files/Next Steps
4. **Compaction cooldown** — Minimum 2 new messages between compaction events (from edge case analysis)
5. **Post-compaction target: ≤60% of limit** — Ensure enough headroom for next turn

---

## Work Objectives

### Core Objective
plugsuits compaction을 프론티어 하네스 수준으로 재설계하여, 8k~80k 모든 context limit에서 "코드베이스 탐색" 프롬프트가 overflow 없이 완주하도록 만든다.

### Concrete Deliverables
- `packages/harness/src/compaction-policy.ts` — 새 threshold 정책 (preemptive + progressive)
- `packages/harness/src/tool-pruning.ts` — Progressive tool output pruning layer
- `packages/harness/src/compaction-prompts.ts` — Structured handoff summary prompt
- `packages/harness/src/checkpoint-history.ts` — Token re-baselining (file tracking lives in CEA per Metis G1/SC2)
- `packages/harness/src/overflow-detection.ts` — Provider-specific error detection (new)
- `packages/cea/src/agent.ts` — Updated config computation
- `packages/headless/src/runner.ts` — Updated compaction integration
- `packages/tui/src/agent-tui.ts` — Updated compaction integration
- `scripts/compaction-benchmark.ts` — 8k/20k/40k/80k comparison test runner (new)
- `scripts/compaction-graph.ts` — Token usage graph generator (new)

### Definition of Done
- [ ] `pnpm test` passes across all packages
- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run build` passes
- [ ] 8k scenario: no `actualTokens > contextLimit` in metrics log
- [ ] 20k scenario: task completes with substantive explanation within max-iterations
- [ ] 40k scenario: task completes with substantive explanation, zero blocking events
- [ ] 80k scenario: task completes cleanly
- [ ] Compaction graph generated showing token usage over time per limit

### Must Have
- Preemptive compaction threshold (configurable, default ~50-65% of context)
- Progressive tool pruning before full summarization
- Structured summary preserving Goal/Files/Next Steps
- Token re-baselining after compaction
- Provider overflow error detection
- Actual-usage-first accounting (probe as source of truth)

### Must NOT Have (Guardrails)
- No breaking changes to `CheckpointHistory` public API shape
- No removal of existing speculative/background compaction capability
- No provider-specific API calls in harness (keep in CEA layer)
- No changes to headless JSONL event protocol
- No removal of existing tests (only additions/updates)

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: YES (vitest across all packages)
- **Automated tests**: TDD (RED → GREEN → REFACTOR)
- **Framework**: vitest

### QA Policy
Every task includes agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/`.

- **Harness unit tests**: `pnpm test --filter @ai-sdk-tool/harness`
- **Headless integration**: `pnpm test --filter @ai-sdk-tool/headless`
- **TUI integration**: `pnpm test --filter @ai-sdk-tool/tui`
- **CEA integration**: `pnpm test --filter plugsuits`
- **E2E scenarios**: Headless runs at 8k/20k/40k/80k with COMPACTION_DEBUG=1

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — types, policy, detection):
├── Task 1: Compaction threshold policy redesign [deep]
├── Task 2: Provider overflow error detection module [quick]
├── Task 3: Progressive tool pruning layer [deep]
└── Task 4: Structured handoff summary prompt [quick]

Wave 2 (Core — checkpoint-history rewrite):
├── Task 5: Token re-baselining after compaction [deep]
├── Task 6: File operation tracking across compactions [unspecified-high]
├── Task 7: Split-turn dual summary support [deep]
└── Task 8: User message replay on overflow [quick]

Wave 3 (Integration — runtime + CEA):
├── Task 9: CEA agent config computation update [quick]
├── Task 10: Headless runner compaction integration [unspecified-high]
├── Task 11: TUI agent-tui compaction integration [unspecified-high]
└── Task 12: Compaction orchestrator update [deep]

Wave 4 (Verification — benchmark + graph):
├── Task 13: 8k/20k/40k/80k benchmark runner script [unspecified-high]
├── Task 14: Token usage graph generator [quick]
├── Task 15: E2E scenario verification at all limits [deep]
└── Task 16: Existing test suite update [unspecified-high]

Wave FINAL (Review):
├── F1: Plan compliance audit [oracle]
├── F2: Code quality review [unspecified-high]
├── F3: Real E2E QA at all 4 limits [unspecified-high]
└── F4: Scope fidelity check [deep]
→ Present results → Get explicit user okay
```

---

## TODOs

### Wave 1 — Foundation (all parallel, no dependencies)

- [x] 1. Compaction Threshold Policy Redesign

  **What to do**:
  - Rewrite `compaction-policy.ts` to use a **preemptive percentage threshold** (default 50% of context window, configurable) inspired by Gemini-CLI
  - Add dual-mode scaling from Crush: `contextWindow > 200k ? fixed 20k reserve : 20% of context`
  - Remove the current `maxTokens`-based soft threshold entirely — replace with `thresholdRatio` (0.5 default)
  - `needsCompaction()` becomes: `actualUsageTokens >= contextWindow * thresholdRatio`
  - `shouldStartSpeculativeCompaction()` becomes: `actualUsageTokens >= contextWindow * (thresholdRatio * 0.75)`
  - Keep `isAtHardContextLimit()` as final safety net
  - TDD: Write RED tests first for new threshold behavior, then implement

  **Must NOT do**: Remove `isAtHardContextLimit()` — it stays as emergency brake

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4)
  - **Blocks**: Tasks 5, 9, 10, 11, 12
  - **Blocked By**: None

  **References**:
  - `packages/harness/src/compaction-policy.ts` — current policy, rewrite target
  - `packages/harness/src/compaction-policy.test.ts` — existing tests to update
  - Gemini-CLI: `DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5` in `chatCompressionService.ts`
  - Goose: `DEFAULT_COMPACTION_THRESHOLD = 0.8` in `context_mgmt/mod.rs:19`
  - Crush: dual-mode `largeContextWindowThreshold=200000, buffer=20000, ratio=0.2` in `agent.go:49-56`
  - Oh-my-pi: `effectiveReserveTokens = max(floor(contextWindow * 0.15), reserveTokens)` in `compaction.ts:209-211`

  **Acceptance Criteria**:
  - [ ] `needsCompaction()` triggers at 50% of context by default
  - [ ] Speculative starts at 37.5% (75% of threshold)
  - [ ] Hard limit unchanged (contextLimit - reserveTokens)
  - [ ] Configurable via `thresholdRatio` in CompactionConfig
  - [ ] All existing policy tests updated and passing

  **QA Scenarios**:
  ```
  Scenario: Preemptive threshold at 50%
    Tool: Bash (pnpm test)
    Steps:
      1. Create CheckpointHistory with contextLimit=20000
      2. Set actualUsage.promptTokens = 9999
      3. Assert needsCompaction() === false
      4. Set actualUsage.promptTokens = 10001
      5. Assert needsCompaction() === true
    Expected: Threshold fires at exactly 50%
    Evidence: .sisyphus/evidence/task-1-threshold.txt
  ```

  **Commit**: YES (groups with Wave 1)
  - Message: `refactor(harness): redesign compaction policy with preemptive threshold`
  - Files: `compaction-policy.ts`, `compaction-policy.test.ts`, `compaction-types.ts`

- [x] 2. Provider Overflow Error Detection Module

  **What to do**:
  - Create new `packages/harness/src/overflow-detection.ts` with `isContextOverflowError(error)` function
  - Add ~15 provider-specific regex patterns for configured providers only (Anthropic, OpenAI/Friendli, Google)
  - Reference Oh-my-pi's `overflow.ts` but only port patterns for providers actually used in plugsuits
  - Add silent overflow detection: `isUsageSilentOverflow(usage, contextWindow)` for providers that don't error
  - Export from harness index.ts
  - TDD with test cases for each provider pattern

  **Must NOT do**: Add provider-specific API calls — this is pattern matching only

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: Tasks 10, 11, 12
  - **Blocked By**: None

  **References**:
  - Oh-my-pi: `packages/ai/src/utils/overflow.ts` — 40+ regex patterns, `isContextOverflow()`, `isUsageSilentOverflow()`
  - Current plugsuits: `checkpoint-history.ts` `isContextOverflowError()` — basic implementation to extend

  **Acceptance Criteria**:
  - [ ] Detects Anthropic "prompt is too long" error
  - [ ] Detects OpenAI "maximum context length" error
  - [ ] Detects Google "exceeds the context window" error
  - [ ] Detects silent overflow via usage comparison
  - [ ] Max 15 patterns total (configured providers only, per SC1)
  - [ ] All patterns have test coverage

  **QA Scenarios**:
  ```
  Scenario: Detect Anthropic context overflow error
    Tool: Bash (pnpm test)
    Steps:
      1. Call isContextOverflowError(new Error("prompt is too long: 150000 tokens > 100000 maximum"))
      2. Assert returns true
      3. Call isContextOverflowError(new Error("rate limit exceeded"))
      4. Assert returns false
    Expected: Only context overflow errors detected, not other API errors
    Evidence: .sisyphus/evidence/task-2-overflow-detection.txt

  Scenario: Detect silent overflow via usage
    Tool: Bash (pnpm test)
    Steps:
      1. Call isUsageSilentOverflow({ inputTokens: 25000 }, 20000)
      2. Assert returns true
      3. Call isUsageSilentOverflow({ inputTokens: 15000 }, 20000)
      4. Assert returns false
    Expected: Silent overflow detected when input > context window
    Evidence: .sisyphus/evidence/task-2-silent-overflow.txt
  ```

  **Commit**: YES (groups with Wave 1)

- [x] 3. Progressive Tool Output Pruning Layer

  **What to do**:
  - Extend existing `packages/harness/src/tool-pruning.ts` with Goose-style progressive pruning
  - Add `progressivePrune(messages, levels)` function that tries pruning at 0%, 10%, 20%, 50%, 100% of tool outputs
  - Implement Goose's "middle-out" removal strategy: remove from middle of tool outputs first, preserving edges
  - Protect recent N tokens of tool outputs (configurable, default 40k like Kilocode/Oh-my-pi)
  - Minimum savings threshold: 20k tokens (from Kilocode)
  - Protected tool names: configurable list (default: ["skill"])
  - This layer runs BEFORE summarization — reduce context cheaply first
  - TDD with progressive removal scenarios

  **Must NOT do**: Remove existing `pruneToolOutputs()` — extend it

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: Tasks 5, 7, 12
  - **Blocked By**: None

  **References**:
  - Goose: `filter_tool_responses()` middle-out strategy in `context_mgmt/mod.rs:228-276`
  - Goose: progressive `removal_percentages = [0, 10, 20, 50, 100]` in `context_mgmt/mod.rs:290-337`
  - Kilocode: `PRUNE_PROTECT=40000, PRUNE_MINIMUM=20000` in `compaction.ts:50-51`
  - Current: `packages/harness/src/tool-pruning.ts` — existing pruning to extend

  **Acceptance Criteria**:
  - [ ] `progressivePrune()` tries 5 levels of removal
  - [ ] Middle-out strategy removes from center first
  - [ ] Recent 40k tokens of tool outputs protected
  - [ ] Only prunes if savings >= 20k tokens
  - [ ] Returns reduction metrics (tokensBefore, tokensAfter, level used)

  **QA Scenarios**:
  ```
  Scenario: Progressive pruning reduces tool outputs at increasing levels
    Tool: Bash (pnpm test --filter @ai-sdk-tool/harness)
    Steps:
      1. Create 20 tool-result messages with 5000-char outputs each (~25k tokens)
      2. Call progressivePrune(messages, { protectRecentTokens: 10000 })
      3. Assert level 0 (0% removal) returns unchanged messages
      4. Assert level 2 (20% removal) removes ~4 middle tool outputs
      5. Assert level 4 (100% removal) removes all unprotected tool outputs
    Expected: Each level removes more tool outputs, middle-out order
    Evidence: .sisyphus/evidence/task-3-progressive-prune.txt

  Scenario: Recent tool outputs are protected from pruning
    Tool: Bash (pnpm test --filter @ai-sdk-tool/harness)
    Steps:
      1. Create 10 tool-result messages, last 3 within protectRecentTokens budget
      2. Call progressivePrune at level 4 (100% removal)
      3. Assert last 3 tool outputs preserved, first 7 removed
    Expected: Recent context always preserved regardless of pruning level
    Evidence: .sisyphus/evidence/task-3-protected-recent.txt
  ```

  **Commit**: YES (groups with Wave 1)

- [x] 4. Structured Handoff Summary Prompt

  **What to do**:
  - Rewrite `DEFAULT_COMPACTION_USER_PROMPT` in `compaction-prompts.ts` using Crush's handoff document structure
  - Required sections: **Current Goal**, **Files & Changes**, **Technical Discoveries**, **Strategy & Approach**, **Exact Next Steps**
  - Add file operation list injection point (read/modified/created files)
  - Add previous summary incremental update capability (from Pi-mono's `UPDATE_SUMMARIZATION_PROMPT`)
  - Add a **verification instruction**: "Did you preserve the user's original request? If not, restate it." (from Gemini-CLI's verification loop idea)
  - Keep the `[INTERNAL COMPACTION INSTRUCTION]` prefix for contamination prevention

  **Must NOT do**: Remove the contamination prevention marker

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: Tasks 5, 7
  - **Blocked By**: None

  **References**:
  - Crush: `internal/agent/templates/summary.md` — 5-section handoff template
  - Kilocode: Goal/Instructions/Discoveries/Accomplished/Relevant files template in `compaction.ts:173-199`
  - Pi-mono: `SUMMARIZATION_SYSTEM_PROMPT` and `UPDATE_SUMMARIZATION_PROMPT` in `compaction/utils.ts`
  - Current: `packages/harness/src/compaction-prompts.ts` — rewrite target

  **Acceptance Criteria**:
  - [ ] Summary prompt has 5 structured sections
  - [ ] File operations list injected into prompt
  - [ ] Previous summary update path works
  - [ ] Internal instruction marker preserved
  - [ ] Prompt tests verify structure

  **QA Scenarios**:
  ```
  Scenario: New summary prompt contains all 5 required sections
    Tool: Bash (pnpm test --filter @ai-sdk-tool/harness -- compaction-prompts)
    Steps:
      1. Import DEFAULT_COMPACTION_USER_PROMPT from compaction-prompts.ts
      2. Assert prompt contains "Current Goal" section header
      3. Assert prompt contains "Files & Changes" section header
      4. Assert prompt contains "Technical Discoveries" section header
      5. Assert prompt contains "Strategy & Approach" section header
      6. Assert prompt contains "Exact Next Steps" section header
      7. Assert prompt starts with "[INTERNAL COMPACTION INSTRUCTION]" marker
    Expected: All 5 sections present, contamination marker preserved
    Evidence: .sisyphus/evidence/task-4-prompt-structure.txt

  Scenario: Previous summary incremental update works
    Tool: Bash (pnpm test --filter @ai-sdk-tool/harness -- compaction-prompts)
    Steps:
      1. Call createModelSummarizer with previousSummary = "Previous goal was X"
      2. Assert summarizer input includes "Previous summary to update" section
      3. Assert summarizer input includes the previous summary text
    Expected: Incremental update path passes previous summary to model
    Evidence: .sisyphus/evidence/task-4-incremental-update.txt
  ```

  **Commit**: YES (groups with Wave 1)

### Wave 2 — Core (depends on Wave 1)

- [x] 5. Token Re-baselining After Compaction

  **What to do**:
  - After successful `compact()`, reset `actualUsage` to match compacted state (inspired by Crush's `PromptTokens=0`)
  - Implement `rebaselineActualUsageToCurrentEstimate()` that sets `promptTokens` to estimated tokens of compacted messages + systemPromptTokens
  - This prevents cascading budget errors where old usage bleeds into new turns
  - Ensure `getContextUsage()` reflects the clean baseline
  - Ensure `getRecommendedMaxOutputTokens()` uses post-compaction values

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 8)
  - **Blocks**: Tasks 9, 10, 11
  - **Blocked By**: Tasks 1, 3

  **References**:
  - Crush: `session.PromptTokens = 0` in `agent.go:444-446`
  - Codex: `recompute_token_usage(turn_context)` in `codex.rs`
  - Current: `checkpoint-history.ts` `rebaselineActualUsageToCurrentEstimate()` — already exists, extend

  **QA Scenarios**:
  ```
  Scenario: Post-compaction usage reflects compacted state
    Tool: Bash (pnpm test --filter @ai-sdk-tool/harness)
    Steps:
      1. Create CheckpointHistory with contextLimit=20000, add messages totaling 15000 estimated tokens
      2. Set actualUsage.promptTokens = 15000
      3. Run compact() with summarizeFn returning "short summary"
      4. Assert getContextUsage().used < 3000 (summary + system prompt only)
      5. Assert getRecommendedMaxOutputTokens() > 10000 (ample headroom)
    Expected: Token accounting fully reset to post-compaction state
    Evidence: .sisyphus/evidence/task-5-rebaseline.txt
  ```

  **Commit**: YES (groups with Wave 2)

- [x] 6. File Operation Tracking via CEA summarizeFn Hook

  **What to do**:
  - Implement file tracking in **CEA layer** (not harness) via a custom `summarizeFn` in `packages/cea/src/agent.ts`
  - The custom summarizeFn extracts file operations from tool-call/tool-result messages before passing to model summarizer
  - Add `FileOperations` interface in CEA: `{ read: Set<string>, modified: Set<string>, created: Set<string> }`
  - Inject file lists into summary prompt text as `<read-files>` and `<modified-files>` (capped at 20 per category)
  - Store previous file ops in closure and carry forward across compactions
  - **Harness provides**: `summarizeFn(messages, previousSummary)` callback (already exists)
  - **CEA provides**: file-tracking-aware implementation of that callback

  **Must NOT do**: Add file tracking types or logic to `packages/harness/` (per Metis G1/SC2)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: Tasks 10, 11
  - **Blocked By**: Task 4

  **References**:
  - Oh-my-pi: `extractFileOpsFromMessage()`, `computeFileLists()` in `compaction/utils.ts` — pattern to port to CEA
  - Pi-mono: Same pattern in `core/compaction/utils.ts`
  - Current: `packages/cea/src/agent.ts` `createModelSummarizer()` — extend with file tracking wrapper
  - Metis G1: "Harness provides hooks/callbacks. CEA provides domain-specific implementations."
  - Metis SC2: "No new file-tracking types or logic in packages/harness/"

  **QA Scenarios**:
  ```
  Scenario: File tracking extracts read/modified files from tool results
    Tool: Bash (pnpm test --filter plugsuits)
    Steps:
      1. Create messages array with read_file tool-call/result for "src/index.ts"
      2. Create messages array with edit_file tool-call/result for "src/utils.ts"
      3. Call CEA summarizeFn with these messages
      4. Assert summary text contains "<read-files>" section with "src/index.ts"
      5. Assert summary text contains "<modified-files>" section with "src/utils.ts"
    Expected: File operations extracted from tool messages and injected into summary
    Evidence: .sisyphus/evidence/task-6-file-tracking.txt
  ```

  **Commit**: YES (groups with Wave 2)

- [x] 7. Split-Turn Dual Summary Support

  **What to do**:
  - When compaction cut point falls mid-turn (between assistant tool-call and tool-result), generate TWO summaries:
    1. History summary: everything before the split turn
    2. Turn prefix summary: messages from turn start to cut point
  - Merge as: `"${history}\n\n---\n\n**Turn Context:**\n\n${turnPrefix}"`
  - Budget: 80% of reserveTokens for history, 50% for turn prefix
  - Improves context preservation for long multi-tool turns

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: Tasks 10, 11
  - **Blocked By**: Tasks 3, 4

  **References**:
  - Pi-mono: `generateTurnPrefixSummary()` in `compaction.ts:1354-1389`
  - Pi-mono: `compact()` split-turn handling in `compaction.ts:1273-1298`

  **QA Scenarios**:
  ```
  Scenario: Split-turn generates dual summaries
    Tool: Bash (pnpm test --filter @ai-sdk-tool/harness)
    Steps:
      1. Create messages: user → assistant(tool-call) → tool-result → assistant(tool-call) → tool-result (mid-turn)
      2. Set keepRecentTokens so cut point falls between the two tool-call/result pairs
      3. Run compact()
      4. Assert summary contains "---" separator between history summary and turn context
      5. Assert messages after compaction include the second tool-call/result pair
    Expected: History and turn prefix are separately summarized, recent turn preserved
    Evidence: .sisyphus/evidence/task-7-split-turn.txt
  ```

  **Commit**: YES (groups with Wave 2)

- [x] 8. User Message Replay on Overflow

  **What to do**:
  - After compaction, find and replay the most recent substantive user message
  - From Kilocode: walk backwards to find last user message without compaction part
  - From Crush: prefix replay with "The previous session was compacted. The initial user request was: ..."
  - Improve existing `auto-with-replay` continuation variant

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: Tasks 10, 11
  - **Blocked By**: None

  **References**:
  - Kilocode: replay logic in `compaction.ts:112-129`
  - Crush: re-queue with intent prefix in `agent.go`
  - Current: `checkpoint-history.ts` `findReplayableUserMessage()` — extend

  **QA Scenarios**:
  ```
  Scenario: User message replayed after overflow compaction
    Tool: Bash (pnpm test --filter @ai-sdk-tool/harness)
    Steps:
      1. Create messages: user("investigate codebase") → assistant → tool-results → overflow
      2. Run compact({ auto: true })
      3. Assert getMessagesForLLM() ends with user message containing "investigate codebase"
    Expected: Original user request preserved and replayed after compaction
    Evidence: .sisyphus/evidence/task-8-replay.txt
  ```

  **Commit**: YES (groups with Wave 2)

### Wave 3 — Integration (depends on Wave 2)

- [x] 9. CEA Agent Config Computation Update

  **What to do**:
  - Update `buildCompactionConfig()` in `agent.ts` to use new `thresholdRatio` field
  - Remove `computeCompactionMaxTokens()` — replaced by threshold ratio
  - Update `computeSpeculativeStartRatio()` to derive from threshold
  - Add `progressivePruning: { enabled: true, protectedTools: ["skill"] }` config
  - Pass file tracking configuration

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10, 11, 12)
  - **Blocks**: Tasks 13, 15
  - **Blocked By**: Tasks 1, 5

  **QA Scenarios**:
  ```
  Scenario: CEA config uses context-size-adaptive threshold
    Tool: Bash (pnpm test --filter plugsuits -- agent)
    Steps:
      1. Create AgentManager with 8k context model
      2. Call buildCompactionConfig()
      3. Assert thresholdRatio ≈ 0.50 (aggressive at small context)
      4. Create AgentManager with 200k context model
      5. Call buildCompactionConfig()
      6. Assert thresholdRatio ≈ 0.70 (relaxed at large context)
    Expected: Threshold adapts to context window size
    Evidence: .sisyphus/evidence/task-9-adaptive-threshold.txt
  ```

  **Commit**: YES (groups with Wave 3)

- [x] 10. Headless Runner Compaction Integration

  **What to do**:
  - Update `runSingleTurn()` to use new compaction flow: probe → progressive prune → compact if still needed
  - Add overflow error detection using new `isContextOverflowError()` from Task 2
  - On overflow error: auto-retry after compaction (inspired by Pi-mono)
  - Update metric emission for new compaction events (prune_applied, progressive_level)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: Tasks 13, 15
  - **Blocked By**: Tasks 1, 2, 3, 5, 6, 7, 8

  **QA Scenarios**:
  ```
  Scenario: Headless runner auto-retries after overflow error
    Tool: Bash (pnpm test --filter @ai-sdk-tool/headless)
    Steps:
      1. Configure mock agent that returns context overflow error on first call, success on second
      2. Configure history at 90% of context limit
      3. Run runHeadless()
      4. Assert compaction event emitted between first and second stream call
      5. Assert second call succeeds
    Expected: Overflow error triggers compaction then retry, not crash
    Evidence: .sisyphus/evidence/task-10-overflow-retry.txt
  ```

  **Commit**: YES (groups with Wave 3)

- [x] 11. TUI Agent-TUI Compaction Integration

  **What to do**:
  - Mirror headless runner changes in TUI
  - Update `prepareMessages()` and `runSingleStreamTurn()` with new flow
  - Add overflow error detection and auto-retry
  - Keep existing background/blocking compaction UI distinction

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: Tasks 13, 15
  - **Blocked By**: Tasks 1, 2, 3, 5, 6, 7, 8

  **QA Scenarios**:
  ```
  Scenario: TUI mirrors headless overflow recovery behavior
    Tool: Bash (pnpm test --filter @ai-sdk-tool/tui)
    Steps:
      1. Verify TUI compaction test suite passes
      2. Assert background/blocking UI labels maintained
    Expected: TUI compaction integration consistent with headless
    Evidence: .sisyphus/evidence/task-11-tui-integration.txt
  ```

  **Commit**: YES (groups with Wave 3)

- [x] 12. Compaction Orchestrator Update

  **What to do**:
  - Update `CompactionOrchestrator` to support new progressive pruning before summarization
  - Add `pruneBeforeCompact()` step in `checkAndCompact()` flow
  - Update `blockAtHardLimit()` to try progressive pruning first, then summarize
  - Emit new events: `prune_start`, `prune_complete`, `prune_skipped`

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: Tasks 13, 15
  - **Blocked By**: Tasks 1, 3

  **QA Scenarios**:
  ```
  Scenario: Orchestrator tries pruning before full summarization
    Tool: Bash (pnpm test --filter @ai-sdk-tool/harness)
    Steps:
      1. Create history with tool-heavy messages above soft threshold
      2. Call checkAndCompact()
      3. Assert prune_start event emitted before compaction_start
      4. If pruning brings tokens below threshold, assert no summarization call
    Expected: Pruning as first-line defense, summarization only if needed
    Evidence: .sisyphus/evidence/task-12-prune-first.txt
  ```

  **Commit**: YES (groups with Wave 3)

### Wave 4 — Verification (depends on Wave 3)

- [x] 13. 8k/20k/40k/80k Benchmark Runner Script

  **What to do**:
  - Create `scripts/compaction-benchmark.ts` that runs all 4 scenarios sequentially
  - Uses COMPACTION_DEBUG=1 and CONTEXT_LIMIT_OVERRIDE for each limit
  - Prompt: "코드베이스를 탐색하고, 이 코드 베이스에 대해서 설명해줘"
  - Captures: metrics.log + trajectory.jsonl per scenario
  - Generates summary report with: compaction count, max tokens reached, blocking count, task completion status

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 14, 15, 16)
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 9, 10, 11, 12

  **QA Scenarios**:
  ```
  Scenario: Benchmark runner produces metrics for all 4 limits
    Tool: Bash
    Steps:
      1. Run: node --import tsx scripts/compaction-benchmark.ts
      2. Assert results/scenario-8000-metrics.log exists and contains compaction events
      3. Assert results/scenario-20000-metrics.log exists
      4. Assert results/scenario-40000-metrics.log exists
      5. Assert results/scenario-80000-metrics.log exists
      6. Assert summary report file exists with counts per scenario
    Expected: All 4 scenarios run and produce parseable metric logs
    Evidence: .sisyphus/evidence/task-13-benchmark.txt
  ```

  **Commit**: YES (groups with Wave 4)

- [x] 14. Token Usage Graph Generator

  **What to do**:
  - Create `scripts/compaction-graph.ts` that reads metrics logs and generates ASCII/SVG token usage graphs
  - X-axis: turn number, Y-axis: token count
  - Shows: actual tokens, context limit line, compaction events (vertical markers), blocking events (red markers)
  - Generates one graph per scenario (8k, 20k, 40k, 80k)
  - Output to `results/compaction-graphs/`

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: F1-F4
  - **Blocked By**: Task 13

  **QA Scenarios**:
  ```
  Scenario: Graph generator produces visual output for each scenario
    Tool: Bash
    Steps:
      1. Run: node --import tsx scripts/compaction-graph.ts results/scenario-20000-metrics.log
      2. Assert output file created at results/compaction-graphs/scenario-20000.txt (or .svg)
      3. Assert output contains turn numbers and token values
    Expected: Readable graph with compaction event markers
    Evidence: .sisyphus/evidence/task-14-graph.txt
  ```

  **Commit**: YES (groups with Wave 4)

- [x] 15. E2E Scenario Verification at All Limits

  **What to do**:
  - Run benchmark script and verify all acceptance criteria
  - For each scenario, verify: no overflow, compaction timing, task completion quality
  - Parse trajectory JSONL for final assistant message — must contain substantive codebase explanation
  - Save evidence to `.sisyphus/evidence/`

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (sequential after Task 13)
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 13, 14

  **QA Scenarios**:
  ```
  Scenario: 8k scenario has no token overflow
    Tool: Bash
    Steps:
      1. Parse results/scenario-8000-metrics.log
      2. Extract all actualTokens values from turn_complete events
      3. Assert max(actualTokens) <= 8192
      4. Assert at least 1 compaction_complete event
    Expected: No turn exceeds context limit, compaction intervened
    Evidence: .sisyphus/evidence/task-15-8k-verify.txt

  Scenario: 20k scenario completes with substantive explanation
    Tool: Bash
    Steps:
      1. Parse results/scenario-20000-trajectory.jsonl
      2. Find last assistant message
      3. Assert message length > 500 characters (substantive, not meta-response)
      4. Assert no "what would you like" or "context was compacted" in final answer
    Expected: Task completed with actual codebase explanation
    Evidence: .sisyphus/evidence/task-15-20k-verify.txt

  Scenario: 40k/80k scenarios have zero blocking events
    Tool: Bash
    Steps:
      1. Parse results/scenario-40000-metrics.log and results/scenario-80000-metrics.log
      2. Count blocking_start events
      3. Assert count == 0 for both
    Expected: Compaction handled preemptively at larger context windows
    Evidence: .sisyphus/evidence/task-15-40k-80k-verify.txt
  ```

  **Commit**: NO

- [x] 16. Existing Test Suite Update

  **What to do**:
  - Update all existing harness/headless/tui/cea tests to work with new compaction policy
  - Ensure `pnpm test` passes across all packages
  - Add new test cases for: progressive pruning, structured summary, token re-baselining, file tracking

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 9, 10, 11, 12

  **QA Scenarios**:
  ```
  Scenario: Full test suite passes after all changes
    Tool: Bash
    Steps:
      1. Run: pnpm test
      2. Assert exit code 0
      3. Run: pnpm run typecheck
      4. Assert exit code 0
      5. Run: pnpm run build
      6. Assert exit code 0
    Expected: Zero regressions across all packages
    Evidence: .sisyphus/evidence/task-16-test-suite.txt
  ```

  **Commit**: YES (groups with Wave 4)

---

## Final Verification Wave

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, grep for function). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
  ```
  QA:
    Tool: Bash + Read
    Steps:
      1. Grep for thresholdRatio in compaction-policy.ts — must exist
      2. Grep for progressivePrune in tool-pruning.ts — must exist
      3. Grep for "Current Goal" in compaction-prompts.ts — must exist
      4. Grep for isContextOverflowError in overflow-detection.ts — must exist
      5. Verify no file-tracking types in packages/harness/src/ (per SC2)
      6. Verify .sisyphus/evidence/ contains task-* files
    Expected: All Must Haves present, all Must NOT Haves absent
    Evidence: .sisyphus/evidence/f1-compliance.txt
  ```

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `pnpm run typecheck` + `pnpm run build` + `pnpm test`. Review all changed files for: `as any`, `@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports.
  ```
  QA:
    Tool: Bash
    Steps:
      1. Run: pnpm run typecheck && echo "PASS" || echo "FAIL"
      2. Run: pnpm run build && echo "PASS" || echo "FAIL"
      3. Run: pnpm test && echo "PASS" || echo "FAIL"
      4. Grep for "as any" in modified files — flag count
      5. Grep for "@ts-ignore" in modified files — must be 0
    Expected: Build PASS, Lint PASS, Tests all pass, zero @ts-ignore
    Evidence: .sisyphus/evidence/f2-quality.txt
  ```

- [x] F3. **Real E2E QA** — `unspecified-high`
  Execute benchmark script for all 4 limits. Parse results and verify acceptance criteria.
  ```
  QA:
    Tool: Bash
    Steps:
      1. Run: node --import tsx scripts/compaction-benchmark.ts
      2. For 8k: grep actualTokens results/scenario-8000-metrics.log, assert max <= 8192
      3. For 20k: parse trajectory, assert final assistant message > 500 chars
      4. For 40k: grep blocking_start results/scenario-40000-metrics.log, assert count == 0
      5. For 80k: grep blocking_start results/scenario-80000-metrics.log, assert count == 0
      6. Verify graph files exist in results/compaction-graphs/
    Expected: All 4 scenarios pass acceptance criteria
    Evidence: .sisyphus/evidence/f3-e2e.txt
  ```

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination.
  ```
  QA:
    Tool: Bash (git diff) + Read
    Steps:
      1. Run: git diff --stat HEAD~4..HEAD — list all changed files
      2. Verify each changed file maps to a task in the plan
      3. Verify no files in packages/harness/src/ contain FileOperations type (per SC2)
      4. Verify JSONL event protocol unchanged (per guardrail)
      5. Verify no new provider-specific API calls in harness (per guardrail)
    Expected: All changes accounted for, no scope creep
    Evidence: .sisyphus/evidence/f4-scope.txt
  ```

---

## Commit Strategy

- Wave 1: `refactor(harness): redesign compaction policy with preemptive threshold and progressive pruning`
- Wave 2: `feat(harness): add token re-baselining, file tracking, split-turn summaries, and user replay`
- Wave 3: `feat(cea,headless,tui): integrate redesigned compaction across all runtimes`
- Wave 4: `test: add 8k/20k/40k/80k benchmark suite with graph generation`

---

## Success Criteria

### Verification Commands
```bash
pnpm run typecheck          # Expected: 0 errors
pnpm run build              # Expected: success
pnpm test                   # Expected: all pass
COMPACTION_DEBUG=1 CONTEXT_LIMIT_OVERRIDE=8000 node --conditions=@ai-sdk-tool/source --import tsx packages/cea/src/entrypoints/main.ts -p "코드베이스를 탐색하고, 이 코드 베이스에 대해서 설명해줘" --no-translate --max-iterations 12
# Expected: no actualTokens > 8000, task completes with explanation
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] 8k/20k/40k/80k scenarios produce substantive codebase explanations
- [ ] No blocking compaction events at 40k/80k
- [ ] Token usage graph generated and saved
