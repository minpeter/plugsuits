// Shared compaction tuning for 30-turn chatbot within 4096 tokens
// Context budget: 4096 tokens total
// Reserve 512 tokens for model output (~12.5% of context)
// Keep 800 tokens of recent messages (~8-10 turns) during compaction
// Trigger blocking compaction at 65% of context (2662 tokens, ~turn 26-28)
// Start speculative compaction at 80% of blocking threshold (2130 tokens, ~turn 22-24)
// Goal: minimize compaction cycles to maximize memory retention
export const COMPACTION_CONTEXT_TOKENS = 4096;
export const COMPACTION_RESERVE_TOKENS = 512;
export const COMPACTION_KEEP_RECENT_TOKENS = 800;
export const COMPACTION_THRESHOLD_RATIO = 0.65;
export const COMPACTION_SPECULATIVE_RATIO = 0.8;
