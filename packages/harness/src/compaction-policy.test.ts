import { describe, expect, it } from "vitest";
import {
  getRecommendedMaxOutputTokens,
  isAtHardContextLimitFromUsage,
  needsCompactionFromUsage,
  shouldStartSpeculativeCompaction,
} from "./compaction-policy";

describe("compaction-policy", () => {
  it("starts speculative compaction from ratio threshold", () => {
    expect(
      shouldStartSpeculativeCompaction({
        contextLimit: 1000,
        input: {
          currentUsageTokens: 760,
          enabled: true,
          hasMessages: true,
          phaseReserveTokens: 200,
          speculativeStartRatio: 0.75,
        },
      })
    ).toBe(true);
  });

  it("falls back to reserve-based predictive threshold", () => {
    expect(
      shouldStartSpeculativeCompaction({
        contextLimit: 1000,
        input: {
          currentUsageTokens: 610,
          enabled: true,
          hasMessages: true,
          phaseReserveTokens: 200,
        },
      })
    ).toBe(true);
  });

  it("computes needsCompaction from usage and reserve", () => {
    expect(
      needsCompactionFromUsage({
        currentUsageTokens: 900,
        enabled: true,
        hasMessages: true,
        thresholdLimit: 900,
      })
    ).toBe(true);
  });

  it("computes hard-limit checks with additional tokens", () => {
    expect(
      isAtHardContextLimitFromUsage({
        additionalTokens: 50,
        contextLimit: 1000,
        currentUsageTokens: 870,
        enabled: true,
        reserveTokens: 100,
      })
    ).toBe(true);
  });

  it("computes recommended max output budget", () => {
    expect(
      getRecommendedMaxOutputTokens({
        contextLimit: 1000,
        estimatedInputTokens: 500,
        reserveTokens: 100,
      })
    ).toBe(340);
  });
});
