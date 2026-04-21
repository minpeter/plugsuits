import { describe, expect, it } from "vitest";
import {
  calculateAggressiveCompactionSplitIndex,
  calculateCompactionSplitIndex,
  calculateDefaultCompactionSplitIndex,
} from "./compaction-planner";
import type { CheckpointMessage } from "./compaction-types";

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
        estimateMessageTokens: (message: CheckpointMessage) => {
          if (typeof message === "number") {
            return message;
          }
          // For CheckpointMessage, estimate from the underlying ModelMessage
          return message.message.content
            ? (message.message.content as unknown as string).length / 4
            : 0;
        },
        keepRecentTokens: 10,
        messages: [
          {
            id: "msg1",
            createdAt: Date.now(),
            isSummary: false,
            message: { role: "user", content: "test1" },
          },
          {
            id: "msg2",
            createdAt: Date.now(),
            isSummary: false,
            message: { role: "assistant", content: "test2" },
          },
          {
            id: "msg3",
            createdAt: Date.now(),
            isSummary: false,
            message: { role: "user", content: "test3" },
          },
        ] as CheckpointMessage[],
      })
    ).toBe(3);
  });

  it("calculates split index with CheckpointMessages", () => {
    const messages: CheckpointMessage[] = [
      {
        id: "msg1",
        createdAt: Date.now(),
        isSummary: false,
        message: { role: "user", content: "a".repeat(80) }, // ~20 tokens
      },
      {
        id: "msg2",
        createdAt: Date.now(),
        isSummary: false,
        message: { role: "assistant", content: "b".repeat(80) }, // ~20 tokens
      },
      {
        id: "msg3",
        createdAt: Date.now(),
        isSummary: false,
        message: { role: "user", content: "c".repeat(80) }, // ~20 tokens
      },
      {
        id: "msg4",
        createdAt: Date.now(),
        isSummary: false,
        message: { role: "assistant", content: "d".repeat(80) }, // ~20 tokens
      },
    ];

    const result = calculateCompactionSplitIndex({
      adjustSplitIndex: (splitIndex) => splitIndex,
      aggressive: false,
      estimateMessageTokens: (msg: CheckpointMessage) =>
        Math.ceil((msg.message.content as string).length / 4),
      keepRecentTokens: 50,
      messages,
    });

    expect(result).toBe(2);
  });
});
