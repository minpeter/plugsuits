import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { CheckpointMessage } from "./compaction-types";
import { analyzeContextTokens } from "./context-analysis";
import { estimateTokens, extractMessageText } from "./token-utils";

let checkpointId = 0;

function makeCheckpoint(message: ModelMessage): CheckpointMessage {
  checkpointId += 1;

  return {
    createdAt: 1_700_000_000_000 + checkpointId,
    id: `checkpoint_${checkpointId}`,
    isSummary: false,
    message,
  };
}

function makeToolResultMessage(
  toolName: string,
  outputText: string
): CheckpointMessage {
  return makeCheckpoint({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `call_${toolName}_${checkpointId}`,
        toolName,
        output: {
          type: "text",
          value: outputText,
        },
      },
    ],
  });
}

describe("analyzeContextTokens", () => {
  it("calculates token totals by role and overall", () => {
    const toolOutput = "File: src/index.ts\nconst answer = 42;";
    const messages: CheckpointMessage[] = [
      makeCheckpoint({
        role: "system",
        content: "You are a coding assistant.",
      }),
      makeCheckpoint({ role: "user", content: "Please inspect src/index.ts" }),
      makeCheckpoint({
        role: "assistant",
        content: "I will inspect the file.",
      }),
      makeToolResultMessage("read_file", toolOutput),
    ];

    const stats = analyzeContextTokens(messages);

    const expectedSystem = estimateTokens(
      extractMessageText(messages[0].message)
    );
    const expectedUser = estimateTokens(
      extractMessageText(messages[1].message)
    );
    const expectedAssistant = estimateTokens(
      extractMessageText(messages[2].message)
    );
    const expectedTool = estimateTokens(
      extractMessageText(messages[3].message)
    );

    expect(stats.byRole).toEqual({
      system: expectedSystem,
      user: expectedUser,
      assistant: expectedAssistant,
      tool: expectedTool,
    });
    expect(stats.total).toBe(
      expectedSystem + expectedUser + expectedAssistant + expectedTool
    );
    expect(stats.toolResults.get("read_file")).toEqual({
      count: 1,
      tokens: estimateTokens(toolOutput),
    });
  });

  it("groups tool results and detects duplicate reads from path-like output", () => {
    const firstOutput = `File: src/utils/math.ts\n${"x".repeat(200)}`;
    const secondOutput = `File: src/utils/math.ts\n${"y".repeat(120)}`;
    const thirdOutput = `File: src/utils/string.ts\n${"z".repeat(80)}`;

    const messages: CheckpointMessage[] = [
      makeToolResultMessage("read_file", firstOutput),
      makeToolResultMessage("read_file", secondOutput),
      makeToolResultMessage("read_file", thirdOutput),
    ];

    const stats = analyzeContextTokens(messages);
    expect(stats.toolResults.get("read_file")).toEqual({
      count: 3,
      tokens:
        estimateTokens(firstOutput) +
        estimateTokens(secondOutput) +
        estimateTokens(thirdOutput),
    });

    const duplicate = stats.duplicateReads.get("src/utils/math.ts");
    const expectedWasted = Math.floor(
      (estimateTokens(firstOutput) + estimateTokens(secondOutput)) / 2
    );

    expect(duplicate).toBeDefined();
    expect(duplicate?.count).toBe(2);
    expect(duplicate?.wastedTokens).toBe(expectedWasted);
    expect(stats.duplicateReads.has("src/utils/string.ts")).toBe(false);
  });

  it("returns top N largest messages sorted by token count", () => {
    const messages: CheckpointMessage[] = [
      makeCheckpoint({ role: "user", content: "a".repeat(4) }),
      makeCheckpoint({ role: "assistant", content: "b".repeat(40) }),
      makeCheckpoint({ role: "user", content: "c".repeat(200) }),
      makeCheckpoint({ role: "assistant", content: "d".repeat(120) }),
    ];

    const stats = analyzeContextTokens(messages, { topN: 2 });
    expect(stats.largestMessages).toHaveLength(2);
    expect(stats.largestMessages.map((item) => item.index)).toEqual([2, 3]);
    expect(stats.largestMessages[0].tokens).toBeGreaterThan(
      stats.largestMessages[1].tokens
    );
  });

  it("returns an empty largestMessages list when topN is zero", () => {
    const messages: CheckpointMessage[] = [
      makeCheckpoint({ role: "user", content: "hello" }),
    ];

    const stats = analyzeContextTokens(messages, { topN: 0 });
    expect(stats.largestMessages).toEqual([]);
  });
});
