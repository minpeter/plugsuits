# Compaction E2E Test Results

Generated: 2026-03-26T08:17:40.447Z


## 8K Context Limit (8,000 tokens)

| Turn | Estimated | Actual | Delta% | Source | Compaction? | Strategy | Blocking (ms) | Tokens After |
|------|-----------|--------|--------|--------|-------------|----------|---------------|--------------|
| 1 | 4,278 | 8,714 | +104% | actual | ✓ YES | unknown | 24899 | 96 |

**Summary:**
- Total turns: 1
- Compaction events: 1
- Blocking events: 1
- Total blocking time: 24899ms
- Avg estimated→actual delta: +103.7%
- First compaction: Turn 1


## 20K Context Limit (20,000 tokens)

| Turn | Estimated | Actual | Delta% | Source | Compaction? | Strategy | Blocking (ms) | Tokens After |
|------|-----------|--------|--------|--------|-------------|----------|---------------|--------------|
| 1 | 76,929 | 7,402 | -90% | estimated | ✓ YES | unknown | 45655 | 165 |

**Summary:**
- Total turns: 1
- Compaction events: 1
- Blocking events: 1
- Total blocking time: 45655ms
- Avg estimated→actual delta: -90.4%
- First compaction: Turn 1


## 40K Context Limit (40,000 tokens)

| Turn | Estimated | Actual | Delta% | Source | Compaction? | Strategy | Blocking (ms) | Tokens After |
|------|-----------|--------|--------|--------|-------------|----------|---------------|--------------|
| 1 | 3,962 | 8,350 | +111% | actual | No | — | 26960 | — |

**Summary:**
- Total turns: 1
- Compaction events: 0
- Blocking events: 1
- Total blocking time: 26960ms
- Avg estimated→actual delta: +110.8%
- First compaction: Turn never
