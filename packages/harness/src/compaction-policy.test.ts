import { describe, expect, it } from "vitest";
import {
  getRecommendedMaxOutputTokens,
  isAtHardContextLimitFromUsage,
  needsCompactionFromUsage,
  shouldCompactFromContextOverflow,
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

describe("shouldCompactFromContextOverflow", () => {
  it("returns true for context_length_exceeded error", () => {
    expect(
      shouldCompactFromContextOverflow(new Error("context_length_exceeded"))
    ).toBe(true);
  });

  it("returns true for context length exceeded error", () => {
    expect(
      shouldCompactFromContextOverflow(
        new Error("Context Length Exceeded: input too large")
      )
    ).toBe(true);
  });

  it("returns true for context window exceeded error", () => {
    expect(
      shouldCompactFromContextOverflow(new Error("context window exceeded"))
    ).toBe(true);
  });

  it("returns true for too many tokens error", () => {
    expect(
      shouldCompactFromContextOverflow(new Error("too many tokens in input"))
    ).toBe(true);
  });

  it("returns true for input is too long error", () => {
    expect(
      shouldCompactFromContextOverflow(new Error("input is too long"))
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(shouldCompactFromContextOverflow(new Error("network timeout"))).toBe(
      false
    );
  });

  it("returns false for non-Error values", () => {
    expect(shouldCompactFromContextOverflow("string error")).toBe(false);
    expect(shouldCompactFromContextOverflow(null)).toBe(false);
    expect(shouldCompactFromContextOverflow(undefined)).toBe(false);
    expect(shouldCompactFromContextOverflow({ message: "error" })).toBe(false);
  });
});
