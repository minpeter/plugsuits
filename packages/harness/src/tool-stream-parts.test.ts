import { describe, expect, it } from "vitest";
import {
  getToolInputChunk,
  getToolInputId,
  getToolLifecycleState,
} from "./tool-stream-parts";

describe("tool-stream-parts", () => {
  it("extracts tool input identifiers and chunks from both field variants", () => {
    expect(getToolInputId({ id: "tool_1" })).toBe("tool_1");
    expect(getToolInputId({ toolCallId: "tool_2" })).toBe("tool_2");
    expect(getToolInputChunk({ delta: '{"path":' })).toBe('{"path":');
    expect(getToolInputChunk({ inputTextDelta: '"src"}' })).toBe('"src"}');
  });

  it("normalizes tool lifecycle part states", () => {
    expect(
      getToolLifecycleState({
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "read",
      })
    ).toEqual({
      state: "tool-call",
      toolCallId: "call_1",
      toolName: "read",
    });
    expect(
      getToolLifecycleState({
        type: "tool-approval-request",
        toolCallId: "call_2",
        toolName: "bash",
      })
    ).toEqual({
      approvalState: "pending",
      state: "approval-requested",
      toolCallId: "call_2",
      toolName: "bash",
    });
    expect(getToolLifecycleState({ type: "text-delta" })).toBeNull();
  });
});
