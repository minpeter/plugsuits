import { Container } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  handleToolApprovalRequest,
  handleToolCall,
  handleToolError,
  handleToolOutputDenied,
  handleToolResult,
  isVisibleStreamPart,
  type PiTuiStreamState,
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

function createState(
  overrides: Partial<PiTuiStreamState> = {}
): { chatContainer: Container; state: PiTuiStreamState } {
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

  it("fires onToolPendingEnd when a tool-result arrives", () => {
    const onToolPendingEnd = vi.fn();
    const { state } = createState({ onToolPendingEnd });

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

  it("fires onToolPendingEnd when a tool-error arrives", () => {
    const onToolPendingEnd = vi.fn();
    const { state } = createState({ onToolPendingEnd });

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

  it("fires onToolPendingEnd when tool output is denied", () => {
    const onToolPendingEnd = vi.fn();
    const { state } = createState({ onToolPendingEnd });

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
});
