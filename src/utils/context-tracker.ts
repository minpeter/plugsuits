import type { LanguageModelUsage } from "ai";

export interface ContextConfig {
  maxContextTokens: number;
  compactionThreshold: number; // 0.0 ~ 1.0, e.g., 0.8 means compact at 80%
}

export interface ContextStats {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  maxContextTokens: number;
  usagePercentage: number;
  shouldCompact: boolean;
}

const DEFAULT_CONFIG: ContextConfig = {
  maxContextTokens: 128_000, // Default for most modern models
  compactionThreshold: 0.85, // Compact when 85% of context is used
};

export class ContextTracker {
  private readonly config: ContextConfig;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private stepCount = 0;
  private currentContextTokens: number | null = null;

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setMaxContextTokens(tokens: number): void {
    this.config.maxContextTokens = tokens;
  }

  setCompactionThreshold(threshold: number): void {
    if (threshold < 0 || threshold > 1) {
      throw new Error("Compaction threshold must be between 0 and 1");
    }
    this.config.compactionThreshold = threshold;
  }

  updateUsage(usage: LanguageModelUsage): void {
    this.totalInputTokens += usage.inputTokens ?? 0;
    this.totalOutputTokens += usage.outputTokens ?? 0;
    this.stepCount++;
  }

  /**
   * Set the exact current context token count.
   */
  setContextTokens(tokens: number): void {
    this.currentContextTokens = Math.max(0, Math.round(tokens));
  }

  /**
   * Set total usage directly (useful after compaction or when loading state)
   */
  setTotalUsage(inputTokens: number, outputTokens: number): void {
    this.totalInputTokens = inputTokens;
    this.totalOutputTokens = outputTokens;
  }

  /**
   * Get estimated current context size
   * Note: This is an approximation based on accumulated usage
   */
  getEstimatedContextTokens(): number {
    // The input tokens from the last request roughly represents
    // the current context size (system prompt + conversation history)
    return this.totalInputTokens > 0
      ? Math.round(this.totalInputTokens / Math.max(this.stepCount, 1))
      : 0;
  }

  getStats(): ContextStats {
    const totalTokens =
      this.currentContextTokens ?? this.getEstimatedContextTokens();
    const usagePercentage = totalTokens / this.config.maxContextTokens;
    const shouldCompact = usagePercentage >= this.config.compactionThreshold;

    return {
      totalTokens,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      maxContextTokens: this.config.maxContextTokens,
      usagePercentage,
      shouldCompact,
    };
  }

  shouldCompact(): boolean {
    return this.getStats().shouldCompact;
  }

  reset(): void {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.stepCount = 0;
    this.currentContextTokens = 0;
  }

  /**
   * Called after compaction to adjust token counts
   * @param newInputTokens The token count of the compacted context
   */
  afterCompaction(newInputTokens: number): void {
    this.totalInputTokens = newInputTokens;
    this.totalOutputTokens = 0;
    this.stepCount = 1;
    this.currentContextTokens = Math.max(0, Math.round(newInputTokens));
  }

  getConfig(): ContextConfig {
    return { ...this.config };
  }
}
