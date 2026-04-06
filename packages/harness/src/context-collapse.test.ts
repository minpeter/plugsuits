import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import type { CheckpointMessage } from "./compaction-types";
import { collapseConsecutiveOps } from "./context-collapse";
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

function makeAssistantToolCall(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>
): CheckpointMessage {
  return makeCheckpoint({
    role: "assistant",
    content: [
      {
        type: "tool-call" as const,
        toolCallId,
        toolName,
        input,
      },
    ],
  });
}

function makeToolResult(
  toolCallId: string,
  toolName: string,
  output: unknown
): CheckpointMessage {
  return makeCheckpoint({
    role: "tool",
    content: [
      {
        type: "tool-result" as const,
        toolCallId,
        toolName,
        output,
      },
    ],
  } as unknown as ModelMessage);
}

function makeUserMessage(text: string): CheckpointMessage {
  return makeCheckpoint({ role: "user", content: text });
}

function estimateCheckpointTokens(messages: CheckpointMessage[]): number {
  return messages.reduce((total, checkpointMessage) => {
    return (
      total + estimateTokens(extractMessageText(checkpointMessage.message))
    );
  }, 0);
}

describe("collapseConsecutiveOps", () => {
  beforeEach(() => {
    checkpointId = 0;
  });

  it("returns unchanged messages when no collapsible sequence exists", () => {
    const messages: CheckpointMessage[] = [
      makeAssistantToolCall("call_1", "read_file", { file_path: "src/a.ts" }),
      makeToolResult("call_1", "read_file", {
        type: "text",
        value: "const a = 1;",
      }),
      makeUserMessage("next"),
    ];

    const result = collapseConsecutiveOps(messages, {
      minGroupSize: 2,
      protectRecentMessages: 0,
    });

    expect(result.groups).toHaveLength(0);
    expect(result.tokensSaved).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("collapses three consecutive reads into one summary label", () => {
    const messages: CheckpointMessage[] = [
      makeAssistantToolCall("call_a", "read_file", { file_path: "src/a.ts" }),
      makeToolResult("call_a", "read_file", {
        type: "text",
        value: "a".repeat(2000),
      }),
      makeAssistantToolCall("call_b", "read_file", { file_path: "src/b.ts" }),
      makeToolResult("call_b", "read_file", {
        type: "text",
        value: "b".repeat(2000),
      }),
      makeAssistantToolCall("call_c", "read_file", { file_path: "src/c.ts" }),
      makeToolResult("call_c", "read_file", {
        type: "text",
        value: "c".repeat(2000),
      }),
    ];

    const result = collapseConsecutiveOps(messages, {
      minGroupSize: 2,
      protectRecentMessages: 0,
    });

    expect(result.groups).toHaveLength(1);

    const group = result.groups[0];
    expect(group.count).toBe(3);
    expect(group.type).toBe("read");
    expect(group.label).toContain("3 file reads");
    expect(group.label).toContain("src/a.ts");
    expect(group.label).toContain("src/b.ts");
    expect(group.label).toContain("src/c.ts");

    const firstResult = result.messages[1].message.content as any[];
    const secondResult = result.messages[3].message.content as any[];
    const thirdResult = result.messages[5].message.content as any[];

    expect(firstResult[0].output).toEqual({ type: "text", value: group.label });
    expect(secondResult[0].output).toEqual({
      type: "text",
      value: group.label,
    });
    expect(thirdResult[0].output).toEqual({ type: "text", value: group.label });
    expect(firstResult[0].toolCallId).toBe("call_a");
    expect(secondResult[0].toolCallId).toBe("call_b");
    expect(thirdResult[0].toolCallId).toBe("call_c");
  });

  it("marks mixed read+search groups as mixed", () => {
    const messages: CheckpointMessage[] = [
      makeAssistantToolCall("call_1", "read_file", { file_path: "src/a.ts" }),
      makeToolResult("call_1", "read_file", {
        type: "text",
        value: "a".repeat(1500),
      }),
      makeAssistantToolCall("call_2", "grep", {
        path: "src",
        pattern: "TODO",
      }),
      makeToolResult("call_2", "grep", {
        type: "text",
        value: "grep results".repeat(300),
      }),
    ];

    const result = collapseConsecutiveOps(messages, {
      minGroupSize: 2,
      protectRecentMessages: 0,
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].count).toBe(2);
    expect(result.groups[0].type).toBe("mixed");
  });

  it("does not collapse operations in protected recent message window", () => {
    const messages: CheckpointMessage[] = [
      makeAssistantToolCall("call_1", "read_file", { file_path: "src/a.ts" }),
      makeToolResult("call_1", "read_file", {
        type: "text",
        value: "a".repeat(1500),
      }),
      makeAssistantToolCall("call_2", "read_file", { file_path: "src/b.ts" }),
      makeToolResult("call_2", "read_file", {
        type: "text",
        value: "b".repeat(1500),
      }),
    ];

    const result = collapseConsecutiveOps(messages, {
      minGroupSize: 2,
      protectRecentMessages: 2,
    });

    expect(result.groups).toHaveLength(0);
    expect(result.tokensSaved).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("reports token savings based on rewritten tool results", () => {
    const messages: CheckpointMessage[] = [
      makeAssistantToolCall("call_1", "read_file", { file_path: "src/a.ts" }),
      makeToolResult("call_1", "read_file", {
        type: "text",
        value: "a".repeat(3000),
      }),
      makeAssistantToolCall("call_2", "read_file", { file_path: "src/b.ts" }),
      makeToolResult("call_2", "read_file", {
        type: "text",
        value: "b".repeat(3000),
      }),
      makeAssistantToolCall("call_3", "read_file", { file_path: "src/c.ts" }),
      makeToolResult("call_3", "read_file", {
        type: "text",
        value: "c".repeat(3000),
      }),
    ];

    const tokensBefore = estimateCheckpointTokens(messages);
    const result = collapseConsecutiveOps(messages, {
      minGroupSize: 2,
      protectRecentMessages: 0,
    });
    const tokensAfter = estimateCheckpointTokens(result.messages);

    expect(result.tokensSaved).toBe(tokensBefore - tokensAfter);
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.groups).toHaveLength(1);
    expect(
      result.groups[0].originalTokens - result.groups[0].collapsedTokens
    ).toBe(result.tokensSaved);
  });

  it("treats non-tool messages as sequence boundaries", () => {
    const messages: CheckpointMessage[] = [
      makeAssistantToolCall("call_1", "read_file", { file_path: "src/a.ts" }),
      makeToolResult("call_1", "read_file", {
        type: "text",
        value: "a".repeat(1500),
      }),
      makeUserMessage("this should break the sequence"),
      makeAssistantToolCall("call_2", "read_file", { file_path: "src/b.ts" }),
      makeToolResult("call_2", "read_file", {
        type: "text",
        value: "b".repeat(1500),
      }),
    ];

    const result = collapseConsecutiveOps(messages, {
      minGroupSize: 2,
      protectRecentMessages: 0,
    });

    expect(result.groups).toHaveLength(0);
    expect(result.tokensSaved).toBe(0);
    expect(result.messages).toEqual(messages);
  });
});
