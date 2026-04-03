import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { CheckpointMessage } from "./compaction-types";
import { adjustSplitIndexForToolPairs } from "./tool-pair-validation";

let checkpointId = 0;

function makeCheckpoint(
  message: ModelMessage | Record<string, unknown>
): CheckpointMessage {
  checkpointId += 1;

  return {
    createdAt: 1_700_000_000_000 + checkpointId,
    id: `checkpoint_${checkpointId}`,
    isSummary: false,
    message: message as ModelMessage,
  };
}

function makeAssistantText(text: string): CheckpointMessage {
  return makeCheckpoint({ role: "assistant", content: text });
}

function makeUserText(text: string): CheckpointMessage {
  return makeCheckpoint({ role: "user", content: text });
}

function makeAssistantToolCall(toolCallId: string): CheckpointMessage {
  return makeCheckpoint({
    role: "assistant",
    content: [
      {
        type: "tool-call" as const,
        toolCallId,
        toolName: `tool_${toolCallId}`,
        input: {},
      },
    ],
  });
}

function makeUserToolResult(toolCallId: string): CheckpointMessage {
  return makeCheckpoint({
    role: "user",
    content: [
      {
        type: "tool-result" as const,
        toolCallId,
        toolName: `tool_${toolCallId}`,
        output: { type: "text" as const, value: `result_${toolCallId}` },
      },
    ],
  });
}

describe("adjustSplitIndexForToolPairs", () => {
  it("returns the proposed index unchanged when there are no tool calls", () => {
    const messages: CheckpointMessage[] = [
      makeUserText("hello"),
      makeAssistantText("world"),
      makeUserText("again"),
    ];

    expect(adjustSplitIndexForToolPairs(messages, 2)).toBe(2);
  });

  it("returns the proposed index unchanged when tool pairs are within kept range", () => {
    const messages: CheckpointMessage[] = [
      makeUserText("start"),
      makeAssistantToolCall("call_1"),
      makeUserToolResult("call_1"),
      makeAssistantText("done"),
    ];

    expect(adjustSplitIndexForToolPairs(messages, 1)).toBe(1);
  });

  it("moves split index backward when kept range starts with orphaned tool-result", () => {
    const messages: CheckpointMessage[] = [
      makeAssistantToolCall("call_1"),
      makeUserToolResult("call_1"),
      makeAssistantText("after"),
    ];

    expect(adjustSplitIndexForToolPairs(messages, 1)).toBe(0);
  });

  it("moves split index backward until all orphaned pairs are covered", () => {
    const messages: CheckpointMessage[] = [
      makeAssistantToolCall("call_a"),
      makeAssistantToolCall("call_b"),
      makeUserToolResult("call_a"),
      makeUserToolResult("call_b"),
      makeAssistantText("tail"),
    ];

    expect(adjustSplitIndexForToolPairs(messages, 3)).toBe(0);
  });

  it("handles nested and interleaved tool-call/tool-result blocks", () => {
    const messages: CheckpointMessage[] = [
      makeAssistantToolCall("call_outer"),
      makeAssistantText("thinking"),
      makeAssistantToolCall("call_inner"),
      makeCheckpoint({
        role: "user",
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call_inner",
            toolName: "tool_call_inner",
            output: { type: "text" as const, value: "inner" },
          },
          {
            type: "text" as const,
            text: "mid",
          },
          {
            type: "tool-result" as const,
            toolCallId: "call_outer",
            toolName: "tool_call_outer",
            output: { type: "text" as const, value: "outer" },
          },
        ],
      }),
      makeAssistantText("complete"),
    ];

    expect(adjustSplitIndexForToolPairs(messages, 3)).toBe(0);
  });
});
