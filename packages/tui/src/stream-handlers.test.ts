import { Container } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  handleToolApprovalRequest,
  handleToolCall,
  handleToolError,
  handleToolOutputDenied,
  handleToolResult,
  IGNORE_PART_TYPES,
  isVisibleStreamPart,
  type PiTuiRenderFlags,
  type PiTuiStreamState,
  STREAM_HANDLERS,
} from "./stream-handlers";
import { BaseToolCallView } from "./tool-call-view";

const markdownTheme = {
  heading: (text: string) => text,
  link: (text: string) => text,
  linkUrl: (text: string) => text,
  code: (text: string) => text,
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => text,
  quote: (text: string) => text,
  quoteBorder: (text: string) => text,
  hr: (text: string) => text,
  listBullet: (text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
  underline: (text: string) => text,
};

function createState(overrides: Partial<PiTuiStreamState> = {}): {
  chatContainer: Container;
  state: PiTuiStreamState;
} {
  const chatContainer = new Container();
  const toolViews = new Map<string, BaseToolCallView>();

  const state: PiTuiStreamState = {
    activeToolInputs: new Map(),
    chatContainer,
    ensureAssistantView: () => {
      throw new Error("assistant view should not be used");
    },
    ensureToolView: (toolCallId, toolName) => {
      const existing = toolViews.get(toolCallId);
      if (existing) {
        return existing;
      }

      const view = new BaseToolCallView(toolCallId, toolName, markdownTheme);
      toolViews.set(toolCallId, view);
      chatContainer.addChild(view);
      return view;
    },
    flags: {
      showFiles: false,
      showFinishReason: false,
      showRawToolIo: false,
      showReasoning: true,
      showSources: false,
      showSteps: false,
      showToolResults: true,
    },
    getToolView: (toolCallId) => toolViews.get(toolCallId),
    pendingToolCallIds: new Set(),
    resetAssistantView: () => undefined,
    streamedToolCallIds: new Set(),
    ...overrides,
  };

  return { chatContainer, state };
}

describe("stream-handlers", () => {
  it("renders tool approval requests instead of ignoring them", () => {
    const { chatContainer, state } = createState();

    handleToolApprovalRequest(
      {
        type: "tool-approval-request",
        toolCallId: "call_approval",
        toolName: "bash",
        reason: "Command modifies the working tree.",
        providerExecuted: false,
      } as never,
      state
    );

    const output = chatContainer.render(120).join("\n");
    expect(output).toContain("Approval");
    expect(output).toContain("Command modifies the working tree.");
    expect(output).toContain("waiting for user or policy decision");
  });

  it("treats tool approval requests as visible stream parts", () => {
    expect(
      isVisibleStreamPart({ type: "tool-approval-request" } as never, {
        showFiles: false,
        showFinishReason: false,
        showRawToolIo: false,
        showReasoning: true,
        showSources: false,
        showSteps: false,
        showToolResults: true,
      })
    ).toBe(true);
  });

  // Regression: approval-gated flows (tool-call → tool-approval-request) used
  // to strand the pending counter at 1 and leave the foreground spinner stuck
  // on "Executing..." while execution was actually paused awaiting approval.
  it("fires onToolPendingEnd when a tool enters the approval gate for a tracked call", () => {
    const onToolPendingEnd = vi.fn();
    const { state } = createState({ onToolPendingEnd });

    handleToolCall(
      {
        type: "tool-call",
        toolCallId: "call_approval",
        toolName: "shell_execute",
        input: { command: "rm -rf /" },
      } as never,
      state
    );
    handleToolApprovalRequest(
      {
        type: "tool-approval-request",
        toolCallId: "call_approval",
        toolName: "shell_execute",
        reason: "Needs user approval.",
        providerExecuted: false,
      } as never,
      state
    );

    expect(onToolPendingEnd).toHaveBeenCalledTimes(1);
  });

  // Regression: approval-request events can appear without a matching
  // tool-call (e.g. early in streamed tests). An unmatched approval must
  // NOT decrement the pending counter, otherwise it can clear the
  // Executing... indicator for other tools still executing in parallel.
  it("does not fire onToolPendingEnd for an approval-request with no matching tool-call", () => {
    const onToolPendingEnd = vi.fn();
    const { state } = createState({ onToolPendingEnd });

    handleToolApprovalRequest(
      {
        type: "tool-approval-request",
        toolCallId: "untracked",
        toolName: "shell_execute",
        reason: "ghost",
        providerExecuted: false,
      } as never,
      state
    );

    expect(onToolPendingEnd).not.toHaveBeenCalled();
  });

  it("approval for unmatched id does not affect another tool's pending counter", () => {
    let pending = 0;
    const { state } = createState({
      onToolPendingStart: () => {
        pending += 1;
      },
      onToolPendingEnd: () => {
        pending -= 1;
      },
    });

    handleToolCall(
      {
        type: "tool-call",
        toolCallId: "call_A",
        toolName: "shell_execute",
        input: { command: "ls" },
      } as never,
      state
    );
    expect(pending).toBe(1);

    handleToolApprovalRequest(
      {
        type: "tool-approval-request",
        toolCallId: "call_UNRELATED",
        toolName: "shell_execute",
        reason: "ghost approval",
        providerExecuted: false,
      } as never,
      state
    );
    expect(pending).toBe(1);

    handleToolResult(
      {
        type: "tool-result",
        toolCallId: "call_A",
        toolName: "shell_execute",
        output: "ok",
      } as never,
      state
    );
    expect(pending).toBe(0);
  });

  it("tool-call → tool-approval-request leaves the pending counter at zero", () => {
    let pending = 0;
    const { state } = createState({
      onToolPendingStart: () => {
        pending += 1;
      },
      onToolPendingEnd: () => {
        pending -= 1;
      },
    });

    handleToolCall(
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "shell_execute",
        input: { command: "rm -rf /" },
      } as never,
      state
    );
    expect(pending).toBe(1);

    handleToolApprovalRequest(
      {
        type: "tool-approval-request",
        toolCallId: "call_1",
        toolName: "shell_execute",
        reason: "Destructive command.",
        providerExecuted: false,
      } as never,
      state
    );
    expect(pending).toBe(0);
  });

  it("fires onToolPendingStart when a tool-call is dispatched", () => {
    const onToolPendingStart = vi.fn();
    const { state } = createState({ onToolPendingStart });

    handleToolCall(
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "shell_execute",
        input: { command: "ls" },
      } as never,
      state
    );

    expect(onToolPendingStart).toHaveBeenCalledTimes(1);
  });

  const dispatchToolCall = (
    state: PiTuiStreamState,
    toolCallId: string
  ): void => {
    handleToolCall(
      {
        type: "tool-call",
        toolCallId,
        toolName: "shell_execute",
        input: { command: "ls" },
      } as never,
      state
    );
  };

  it("fires onToolPendingEnd when a tool-result arrives for a tracked call", () => {
    const onToolPendingEnd = vi.fn();
    const { state } = createState({ onToolPendingEnd });

    dispatchToolCall(state, "call_1");
    handleToolResult(
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "shell_execute",
        output: "files",
      } as never,
      state
    );

    expect(onToolPendingEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onToolPendingEnd when a tool-error arrives for a tracked call", () => {
    const onToolPendingEnd = vi.fn();
    const { state } = createState({ onToolPendingEnd });

    dispatchToolCall(state, "call_1");
    handleToolError(
      {
        type: "tool-error",
        toolCallId: "call_1",
        toolName: "shell_execute",
        error: new Error("boom"),
      } as never,
      state
    );

    expect(onToolPendingEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onToolPendingEnd when tool output is denied for a tracked call", () => {
    const onToolPendingEnd = vi.fn();
    const { state } = createState({ onToolPendingEnd });

    dispatchToolCall(state, "call_1");
    handleToolOutputDenied(
      {
        type: "tool-output-denied",
        toolCallId: "call_1",
        toolName: "shell_execute",
      } as never,
      state
    );

    expect(onToolPendingEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onToolPendingEnd even when showToolResults flag is disabled", () => {
    const onToolPendingEnd = vi.fn();
    const { state } = createState({
      onToolPendingEnd,
      flags: {
        showFiles: false,
        showFinishReason: false,
        showRawToolIo: false,
        showReasoning: true,
        showSources: false,
        showSteps: false,
        showToolResults: false,
      },
    });

    dispatchToolCall(state, "call_1");
    handleToolResult(
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "shell_execute",
        output: "files",
      } as never,
      state
    );

    expect(onToolPendingEnd).toHaveBeenCalledTimes(1);
  });

  // Regression: a second terminal event for the same tool call (e.g. stream
  // replay or buggy provider) must NOT double-decrement the pending counter.
  it("does not fire onToolPendingEnd twice for the same tool call", () => {
    const onToolPendingEnd = vi.fn();
    const { state } = createState({ onToolPendingEnd });

    dispatchToolCall(state, "call_1");
    handleToolResult(
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "shell_execute",
        output: "files",
      } as never,
      state
    );
    handleToolResult(
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "shell_execute",
        output: "files",
      } as never,
      state
    );

    expect(onToolPendingEnd).toHaveBeenCalledTimes(1);
  });

  // Regression: a second tool-call for the same id must NOT double-increment
  // the pending counter (dispatch is idempotent on the id).
  it("does not fire onToolPendingStart twice for the same tool call id", () => {
    const onToolPendingStart = vi.fn();
    const { state } = createState({ onToolPendingStart });

    dispatchToolCall(state, "call_1");
    dispatchToolCall(state, "call_1");

    expect(onToolPendingStart).toHaveBeenCalledTimes(1);
  });
});

const FLAGS_ALL_ON: PiTuiRenderFlags = {
  showFiles: true,
  showFinishReason: true,
  showRawToolIo: true,
  showReasoning: true,
  showSources: true,
  showSteps: true,
  showToolResults: true,
};

const FLAGS_ALL_OFF: PiTuiRenderFlags = {
  showFiles: false,
  showFinishReason: false,
  showRawToolIo: false,
  showReasoning: false,
  showSources: false,
  showSteps: false,
  showToolResults: false,
};

describe("isVisibleStreamPart — reasoning parts must never trigger first-visible", () => {
  // Regression: if reasoning parts become visible, clearStreamingLoader fires
  // on reasoning-start and the "Thinking..." spinner label is lost.
  it.each([
    "reasoning-start",
    "reasoning-delta",
    "reasoning-end",
  ] as const)("%s is invisible regardless of flags", (type) => {
    expect(isVisibleStreamPart({ type } as never, FLAGS_ALL_ON)).toBe(false);
    expect(isVisibleStreamPart({ type } as never, FLAGS_ALL_OFF)).toBe(false);
  });

  it("tool-input-end is always invisible", () => {
    expect(
      isVisibleStreamPart({ type: "tool-input-end" } as never, FLAGS_ALL_ON)
    ).toBe(false);
  });

  it("tool-result visibility follows showToolResults flag", () => {
    expect(
      isVisibleStreamPart({ type: "tool-result" } as never, FLAGS_ALL_ON)
    ).toBe(true);
    expect(
      isVisibleStreamPart({ type: "tool-result" } as never, FLAGS_ALL_OFF)
    ).toBe(false);
  });

  it("text-start is always visible (triggers spinner clear)", () => {
    expect(
      isVisibleStreamPart({ type: "text-start" } as never, FLAGS_ALL_OFF)
    ).toBe(true);
  });
});

describe("STREAM_HANDLERS dispatch table", () => {
  // Regression: reasoning-end previously lived in IGNORE_PART_TYPES, which
  // silently dropped onReasoningEnd and left spinner label stuck.
  it.each([
    "text-start",
    "text-delta",
    "reasoning-start",
    "reasoning-delta",
    "reasoning-end",
    "tool-input-start",
    "tool-input-delta",
    "tool-input-end",
    "tool-call",
    "tool-result",
    "tool-error",
    "tool-output-denied",
    "tool-approval-request",
    "finish-step",
    "finish",
    "file",
    "source",
  ] as const)("%s has a dispatch handler", (type) => {
    expect(STREAM_HANDLERS[type]).toBeDefined();
    expect(typeof STREAM_HANDLERS[type]).toBe("function");
  });

  it("reasoning-end is NOT in the ignore set", () => {
    expect(IGNORE_PART_TYPES.has("reasoning-end")).toBe(false);
  });

  it("reasoning-start is NOT in the ignore set", () => {
    expect(IGNORE_PART_TYPES.has("reasoning-start")).toBe(false);
  });
});

describe("Reasoning lifecycle callbacks", () => {
  const stubAssistantView = () => {
    const view = { appendText: vi.fn(), appendReasoning: vi.fn() };
    return view as never;
  };

  it("handleReasoningStart calls state.onReasoningStart", () => {
    const onReasoningStart = vi.fn();
    const onReasoningEnd = vi.fn();
    const { state } = createState({
      onReasoningStart,
      onReasoningEnd,
      ensureAssistantView: stubAssistantView,
    });

    STREAM_HANDLERS["reasoning-start"](
      { type: "reasoning-start" } as never,
      state
    );

    expect(onReasoningStart).toHaveBeenCalledTimes(1);
    expect(onReasoningEnd).not.toHaveBeenCalled();
  });

  it("handleReasoningEnd calls state.onReasoningEnd", () => {
    const onReasoningStart = vi.fn();
    const onReasoningEnd = vi.fn();
    const { state } = createState({
      onReasoningStart,
      onReasoningEnd,
      ensureAssistantView: stubAssistantView,
    });

    STREAM_HANDLERS["reasoning-end"]({ type: "reasoning-end" } as never, state);

    expect(onReasoningEnd).toHaveBeenCalledTimes(1);
    expect(onReasoningStart).not.toHaveBeenCalled();
  });

  it("reasoning-start fires callback even when showReasoning flag is off", () => {
    const onReasoningStart = vi.fn();
    const { state } = createState({
      onReasoningStart,
      ensureAssistantView: stubAssistantView,
      flags: { ...FLAGS_ALL_OFF, showReasoning: false },
    });

    STREAM_HANDLERS["reasoning-start"](
      { type: "reasoning-start" } as never,
      state
    );

    expect(onReasoningStart).toHaveBeenCalledTimes(1);
  });
});

describe("Tool pending counter invariants (parallel tool calls)", () => {
  // Regression: parallel tool calls must keep the foreground "Executing..."
  // spinner alive until ALL pending calls resolve (counter floor at 0).
  it("each tool-call fires exactly one onToolPendingStart", () => {
    const onToolPendingStart = vi.fn();
    const { state } = createState({ onToolPendingStart });

    STREAM_HANDLERS["tool-call"](
      {
        type: "tool-call",
        toolCallId: "p1",
        toolName: "a",
        input: {},
      } as never,
      state
    );
    STREAM_HANDLERS["tool-call"](
      {
        type: "tool-call",
        toolCallId: "p2",
        toolName: "b",
        input: {},
      } as never,
      state
    );

    expect(onToolPendingStart).toHaveBeenCalledTimes(2);
  });

  it("each tracked terminal tool part fires exactly one onToolPendingEnd", () => {
    const onToolPendingEnd = vi.fn();
    const { state } = createState({ onToolPendingEnd });

    for (const id of ["p1", "p2", "p3"]) {
      handleToolCall(
        {
          type: "tool-call",
          toolCallId: id,
          toolName: "x",
          input: {},
        } as never,
        state
      );
    }

    handleToolResult(
      {
        type: "tool-result",
        toolCallId: "p1",
        toolName: "a",
        output: "ok",
      } as never,
      state
    );
    handleToolError(
      {
        type: "tool-error",
        toolCallId: "p2",
        toolName: "b",
        error: new Error("boom"),
      } as never,
      state
    );
    handleToolOutputDenied(
      {
        type: "tool-output-denied",
        toolCallId: "p3",
        toolName: "c",
      } as never,
      state
    );

    expect(onToolPendingEnd).toHaveBeenCalledTimes(3);
  });
});
