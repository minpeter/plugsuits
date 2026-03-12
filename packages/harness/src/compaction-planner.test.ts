import { describe, expect, it } from "vitest";
import {
  calculateAggressiveCompactionSplitIndex,
  calculateCompactionSplitIndex,
  calculateDefaultCompactionSplitIndex,
} from "./compaction-planner";

describe("compaction-planner", () => {
  it("calculates default split index from keepRecentTokens", () => {
    const result = calculateDefaultCompactionSplitIndex({
      adjustSplitIndex: (splitIndex) => splitIndex,
      estimateMessageTokens: (message: number) => message,
      keepRecentTokens: 50,
      messages: [20, 20, 20, 20],
    });

    expect(result).toBe(2);
  });

  it("falls back to midpoint when keepRecent covers everything", () => {
    const result = calculateDefaultCompactionSplitIndex({
      adjustSplitIndex: (splitIndex) => splitIndex,
      estimateMessageTokens: (message: number) => message,
      keepRecentTokens: 100,
      messages: [20, 20, 20],
    });

    expect(result).toBe(1);
  });

  it("calculates aggressive split index", () => {
    expect(calculateAggressiveCompactionSplitIndex(3)).toBe(3);
    expect(calculateAggressiveCompactionSplitIndex(1)).toBeNull();
  });

  it("routes compaction split calculation by aggressive flag", () => {
    expect(
      calculateCompactionSplitIndex({
        adjustSplitIndex: (splitIndex) => splitIndex,
        aggressive: true,
        estimateMessageTokens: (message: number) => message,
        keepRecentTokens: 10,
        messages: [10, 10, 10],
      })
    ).toBe(3);
  });
});
