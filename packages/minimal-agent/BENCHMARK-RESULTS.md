# Compaction Benchmark Results

## Test Configuration
- Model: GLM-5 (FriendliAI)
- Temperature: 0
- Benchmark: 80-turn conversation with memory probes every 5 turns
- 17 probes testing: name, job, pets, family, hobbies, favorites, travel, health, home, social

## Results Summary

### Baseline (first commit, before improvements)
Measured at commit `915d862` (initial speculative compaction config, no memory features).

| Context | Retention | Probes | Compactions |
|---------|-----------|--------|-------------|
| 2000 | 53% (9/17)* | 17 | 1 |
| 4096 | 82% (14/17)* | 17 | 0 |

*30-turn benchmark only (50/80-turn not available at baseline)

### After prompt optimization (4 techniques from Claude Code)
Commit `49abb72` — analysis scratchpad, user messages list, fact preservation, partial awareness.

| Context | Retention | Key Improvement |
|---------|-----------|----------------|
| 2000 | 62% (23/37) | Turn 35 post-compaction: 4/4 vs baseline 0/4 |
| 4096 | 62% (23/37) | — |

### After real-time fact extraction
Commit `45452c1` — extractFactsFromUserMessage with 16 regex patterns.

| Context | Retention | Compactions |
|---------|-----------|-------------|
| 2000 | 59% (22/37) | 6 |

### Final (all 12 gaps closed + runtime wiring)
Commit `41e1b5f` — full context management parity.

| Context | Retention | Probes | Compactions | Peak Tokens |
|---------|-----------|--------|-------------|-------------|
| 2000 | 60% (37/62) | 62 | 0 | 935 |
| 4096 | 58% (36/62) | 62 | 0 | 2051 |

### Opus model test (for comparison)
| Context | Retention | Note |
|---------|-----------|------|
| 4096 | 94% (16/17) | 30-turn only. Proves model quality is the retention ceiling |

## Key Observations

1. **Context collapse + microCompact** keep 80 turns under compaction threshold even at 2000 tokens
2. **Chatbot compaction prompt** (4 techniques) dramatically improves post-compaction recall: Turn 35 goes from 0/4 to 4/4
3. **Model quality is the dominant factor**: same config with Opus → 94% vs GLM-5 → ~60%
4. **Real-time fact extraction** helps when compaction fires (2k context, 50 turns: 38% → 59%)

## Reproduction

```bash
# Run 80-turn benchmark
pnpm --filter @plugsuits/minimal-agent benchmark --context-limit 2000 --output results/2000.json
pnpm --filter @plugsuits/minimal-agent benchmark --context-limit 4096 --output results/4096.json

# Run baseline comparison (code-agent prompt, no memory)
pnpm --filter @plugsuits/minimal-agent benchmark --baseline --output results/baseline.json

# Generate charts
python3 packages/minimal-agent/visualize.py results/*.json --output charts/
```
