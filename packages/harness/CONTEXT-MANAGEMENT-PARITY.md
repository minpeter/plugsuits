# Context Management: Claude Code vs Plugsuits Harness

## Comparison Matrix

| # | Claude Code Feature | Problem It Solves | Harness Module | Status | Runtime Wired |
|---|---|---|---|---|---|
| 1 | Session Memory Compaction | LLM summary quality bypass | `checkpoint-history.ts` compact() SM path | ✅ Implemented | ✅ compact() hot path |
| 2 | API Context Management | Server-side content clearing | `api-context-management.ts` | ✅ Interface ready | ⚠️ Provider adapter needed |
| 3 | Context Collapse | Group consecutive read/search ops | `context-collapse.ts` | ✅ Implemented | ✅ compact() pipeline |
| 4 | Context Analysis | Per-tool token breakdown | `context-analysis.ts` | ✅ Implemented | ✅ TUI footer |
| 5 | Context Suggestions | User-facing optimization warnings | `context-suggestions.ts` | ✅ Implemented | ✅ TUI footer |
| 6 | Tool Pair Validation | Prevent orphaned tool_result | `tool-pair-validation.ts` | ✅ Implemented | ✅ Both split paths |
| 7 | Output Token Reserve | Reserve tokens for compaction call | `compaction-policy.ts` computeContextBudget | ✅ Implemented | ✅ Orchestrator + History |
| 8 | Effective Context Window | contextWindow - reservedForSummary | `compaction-policy.ts` computeContextBudget | ✅ Implemented | ✅ Threshold decisions |
| 9 | Buffer Tokens | Multi-level thresholds | `compaction-policy.ts` ContextBudget type | ✅ Implemented | ✅ Threshold decisions |
| 10 | Circuit Breaker (session) | Per-session failure tracking | `compaction-circuit-breaker.ts` | ✅ Implemented | ✅ Session change handlers |
| 11 | Partial Compaction | Bidirectional (prefix/suffix) | `checkpoint-history.ts` compactionDirection | ✅ Implemented | ✅ Config option |
| 12 | Post-Compact Restoration | Re-attach files/skills | `post-compact-restoration.ts` | ✅ Implemented | ✅ CEA compaction callback |

## Features Unique to Plugsuits (not in Claude Code)

| Feature | Module | Description |
|---|---|---|
| Real-time fact extraction | `session-memory.ts` extractFactsFromUserMessage | 16 regex patterns, zero LLM cost |
| Background Memory Extractor | `background-memory-extractor.ts` | LLM-based periodic extraction with presets |
| Memory Presets | `memory-presets.ts` | Chat + Code templates |
| Benchmark tooling | `minimal-agent/benchmark.ts` | 80-turn memory probe benchmark with visualization |

## Status Legend

- ✅ Implemented: Code exists with unit tests
- ✅ Runtime Wired: Called in production execution path
- ⚠️ Provider adapter needed: Interface ready, requires provider-specific integration

## Notes

### Gap 2 (API Context Management)
This is a provider-specific API feature (Anthropic `clear_tool_uses_20250919`). Our implementation provides the provider-agnostic interface (`buildContextManagementConfig`). Actual server-side clearing requires the provider SDK to support passing this config, which is provider-dependent. The harness provides the abstraction layer.

### Gap 12 (Post-Compact Restoration)
CEA wires `PostCompactRestorer` and tracks file reads via `trackItem()` in the tool result processing path. Minimal-agent does not use restoration (no file operations). The restorer is a library utility — consuming agents opt in by calling `trackItem()` when they access resources they want preserved across compaction.
