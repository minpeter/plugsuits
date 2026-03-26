# Learnings

## 2026-03-26 Session Start

### buildCompactionConfig() — packages/cea/src/agent.ts:396-424
```typescript
buildCompactionConfig(overrides?: Partial<CompactionConfig>): CompactionConfig {
  const contextLength = getModelContextLength(this.modelId, this.provider);  // model-derived
  const compactionReserveTokens = getCompactionReserveTokens(this.modelId, this.provider);
  const summarizeFn = createModelSummarizer(
    this.getProviderModel(this.modelId, this.provider),
    { instructions: () => this.getInstructions(), contextLimit: contextLength }
  );
  return {
    contextLimit: contextLength,
    enabled: true,
    maxTokens: contextLength,
    reserveTokens: compactionReserveTokens,
    keepRecentTokens: Math.floor(contextLength * 0.3),  // 30% of contextLength
    speculativeStartRatio: computeSpeculativeStartRatio(contextLength, compactionReserveTokens),
    summarizeFn,
    ...overrides,
  };
}
```
CRITICAL: summarizeFn also uses contextLength for its own budget — must recreate with overridden value.

### Headless runner callbacks — packages/headless/src/runner.ts:101-123
Currently wires only 4/9 callbacks: onApplied, onError, onRejected, onStillExceeded
Missing: onBlockingChange, onJobStatus, onCompactionStart, onCompactionComplete, onCompactionError

### DEBUG_TOKENS pattern (runner.ts:157-171)
```typescript
if (!process.env.DEBUG_TOKENS) { return; }
console.error(`[debug:headless] total_tokens=${total} ...`);
```
Follow same pattern for COMPACTION_DEBUG: check env var, use console.error, prefix with [compaction-metric].

### Turn counting in runner.ts
- `totalIterationCount` is the loop counter (L97)
- `processAgentResponse` at L260+ is the main outer loop
- Turn = each call to `processInput(prompt)` in the outer loop

### headless entrypoint
- packages/cea/src/entrypoints/main.ts (NOT headless.ts)
- buildCompactionConfig called at L356: `messageHistory.updateCompaction(agentManager.buildCompactionConfig())`
- There's also a separate headless.ts entrypoint at packages/cea/src/entrypoints/ — need to verify

### Scripts directory  
- scripts/ at repo root

### CompactionOrchestratorCallbacks (9 callbacks)
onCompactionStart, onCompactionComplete, onCompactionError, onApplied, onBlockingChange, onError, onJobStatus, onRejected, onStillExceeded

## 2026-03-26 E2E Run Results

- 8K scenario: first compaction triggered on turn 1; blocking occurred for 20124ms; estimated→actual token ratio was 4404:8690 (~1.97x actual).
- 20K scenario: first compaction triggered on turn 1; blocking occurred for 28933ms; estimated→actual token ratio was 5034:20323 (~4.04x actual).
- 40K scenario: compaction never triggered; blocking still occurred for 19578ms; estimated→actual token ratio was 4051:14014 (~3.46x actual).
- Notable outcome: all three scenarios blocked on turn 1, but only 8K and 20K recorded compaction events in the analyzer report.
