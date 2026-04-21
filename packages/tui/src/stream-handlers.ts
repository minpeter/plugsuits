import {
  getToolInputChunk as sharedGetToolInputChunk,
  getToolInputId as sharedGetToolInputId,
} from "@ai-sdk-tool/harness";
import {
  type Container,
  type Markdown,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";
import type { TextStreamPart, ToolSet } from "ai";
import type { AssistantStreamView } from "./stream-views";
import type { ToolCallView } from "./tool-call-view";

type StreamPart = TextStreamPart<ToolSet>;

const fallbackGetToolInputId = (part: {
  id?: string;
  toolCallId?: string;
}): string | undefined => part.id ?? part.toolCallId;

const fallbackGetToolInputChunk = (part: {
  delta?: unknown;
  inputTextDelta?: unknown;
}): string | null => {
  if (typeof part.delta === "string") {
    return part.delta;
  }

  if (typeof part.inputTextDelta === "string") {
    return part.inputTextDelta;
  }

  return null;
};

const getToolInputId =
  typeof sharedGetToolInputId === "function"
    ? sharedGetToolInputId
    : fallbackGetToolInputId;

const getToolInputChunk =
  typeof sharedGetToolInputChunk === "function"
    ? sharedGetToolInputChunk
    : fallbackGetToolInputChunk;

export interface ToolInputRenderState {
  hasContent: boolean;
  inputBuffer: string;
  renderedInputLength: number;
  toolName: string;
}

const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const UNKNOWN_TOOL_NAME = "tool";

export const addChatComponent = (
  chatContainer: Container,
  component: Container | Text | Markdown,
  options: { addLeadingSpacer?: boolean } = {}
): void => {
  if (options.addLeadingSpacer ?? true) {
    chatContainer.addChild(new Spacer(1));
  }

  chatContainer.addChild(component);
};

export const createToolInputState = (
  toolName: string
): ToolInputRenderState => ({
  toolName,
  hasContent: false,
  inputBuffer: "",
  renderedInputLength: 0,
});

export interface PiTuiRenderFlags {
  showFiles: boolean;
  showFinishReason: boolean;
  showRawToolIo: boolean;
  showReasoning: boolean;
  showSources: boolean;
  showSteps: boolean;
  showToolResults: boolean;
}

export interface PiTuiStreamState {
  activeToolInputs: Map<string, ToolInputRenderState>;
  chatContainer: Container;
  ensureAssistantView: () => AssistantStreamView;
  ensureToolView: (toolCallId: string, toolName: string) => ToolCallView;
  flags: PiTuiRenderFlags;
  getToolView: (toolCallId: string) => ToolCallView | undefined;
  onReasoningEnd?: () => void;
  onReasoningStart?: () => void;
  onToolPendingEnd?: () => void;
  onToolPendingStart?: () => void;
  pendingToolCallIds: Set<string>;
  resetAssistantView: (suppressLeadingSpacer?: boolean) => void;
  streamedToolCallIds: Set<string>;
}

export const syncToolInputToView = async (
  state: PiTuiStreamState,
  toolCallId: string,
  toolState: ToolInputRenderState
): Promise<void> => {
  const hasKnownToolName = toolState.toolName !== UNKNOWN_TOOL_NAME;
  if (!(state.flags.showRawToolIo || hasKnownToolName)) {
    return;
  }

  const existingView = state.getToolView(toolCallId);
  const pendingInput = toolState.inputBuffer.slice(
    toolState.renderedInputLength
  );
  if (!existingView && pendingInput.length === 0) {
    return;
  }

  state.resetAssistantView(true);
  const toolView =
    existingView ?? state.ensureToolView(toolCallId, toolState.toolName);

  if (pendingInput.length === 0) {
    return;
  }

  await toolView.appendInputChunk(pendingInput);
  toolState.renderedInputLength = toolState.inputBuffer.length;
};

export const createInfoMessage = (title: string, value: unknown): Text =>
  new Text(`${title}\n${safeStringify(value)}`, 1, 0);

export type StreamPartHandler = (
  part: StreamPart,
  state: PiTuiStreamState
) => void | Promise<void>;

export const handleTextStart: StreamPartHandler = (_part, state) => {
  state.ensureAssistantView();
};

export const handleTextDelta: StreamPartHandler = (part, state) => {
  const textPart = part as Extract<StreamPart, { type: "text-delta" }>;
  state.ensureAssistantView().appendText(textPart.text);
};

export const handleReasoningStart: StreamPartHandler = (_part, state) => {
  if (state.flags.showReasoning) {
    state.ensureAssistantView();
  }
  state.onReasoningStart?.();
};

export const handleReasoningDelta: StreamPartHandler = (part, state) => {
  if (!state.flags.showReasoning) {
    return;
  }

  const reasoningPart = part as Extract<
    StreamPart,
    { type: "reasoning-delta" }
  >;
  state.ensureAssistantView().appendReasoning(reasoningPart.text);
};

export const handleReasoningEnd: StreamPartHandler = (_part, state) => {
  state.onReasoningEnd?.();
};

export const handleToolInputStart: StreamPartHandler = async (part, state) => {
  const toolInputStartPart = part as Extract<
    StreamPart,
    { type: "tool-input-start" }
  >;
  const toolCallId = getToolInputId(toolInputStartPart);
  if (!toolCallId) {
    return;
  }

  const existingState = state.activeToolInputs.get(toolCallId);
  const toolState =
    existingState ?? createToolInputState(toolInputStartPart.toolName);
  toolState.toolName = toolInputStartPart.toolName;

  state.activeToolInputs.set(toolCallId, toolState);
  state.streamedToolCallIds.add(toolCallId);
  await syncToolInputToView(state, toolCallId, toolState);
};

export const handleToolInputDelta: StreamPartHandler = async (part, state) => {
  const toolInputDeltaPart = part as Extract<
    StreamPart,
    { type: "tool-input-delta" }
  >;
  const toolCallId = getToolInputId(toolInputDeltaPart);
  if (!toolCallId) {
    return;
  }

  if (!state.activeToolInputs.has(toolCallId)) {
    state.activeToolInputs.set(
      toolCallId,
      createToolInputState(UNKNOWN_TOOL_NAME)
    );
  }

  const toolState = state.activeToolInputs.get(toolCallId);
  const chunk = getToolInputChunk(toolInputDeltaPart);

  if (chunk && toolState) {
    toolState.inputBuffer += chunk;
    toolState.hasContent = true;
    await syncToolInputToView(state, toolCallId, toolState);
  }

  state.streamedToolCallIds.add(toolCallId);
};

export const handleToolInputEnd: StreamPartHandler = (part, state) => {
  const toolInputEndPart = part as Extract<
    StreamPart,
    { type: "tool-input-end" }
  >;
  const toolCallId = getToolInputId(toolInputEndPart);
  if (toolCallId) {
    state.streamedToolCallIds.add(toolCallId);
  }
};

const firePendingEndIfTracked = (
  state: PiTuiStreamState,
  toolCallId: string
): void => {
  if (!state.pendingToolCallIds.delete(toolCallId)) {
    return;
  }
  state.onToolPendingEnd?.();
};

export const handleToolCall: StreamPartHandler = (part, state) => {
  const toolCallPart = part as Extract<StreamPart, { type: "tool-call" }>;
  const inputState = state.activeToolInputs.get(toolCallPart.toolCallId);
  const shouldSkipToolCallRender =
    state.streamedToolCallIds.has(toolCallPart.toolCallId) &&
    inputState?.hasContent === true;

  state.activeToolInputs.delete(toolCallPart.toolCallId);
  state.streamedToolCallIds.delete(toolCallPart.toolCallId);

  state.resetAssistantView(true);
  const view = state.ensureToolView(
    toolCallPart.toolCallId,
    toolCallPart.toolName
  );
  view.setFinalInput(toolCallPart.input);

  if (!shouldSkipToolCallRender) {
    view.setToolName(toolCallPart.toolName);
  }

  if (!state.pendingToolCallIds.has(toolCallPart.toolCallId)) {
    state.pendingToolCallIds.add(toolCallPart.toolCallId);
    state.onToolPendingStart?.();
  }
};

export const handleToolResult: StreamPartHandler = (part, state) => {
  const toolResultPart = part as Extract<StreamPart, { type: "tool-result" }>;
  firePendingEndIfTracked(state, toolResultPart.toolCallId);

  if (!state.flags.showToolResults) {
    return;
  }

  state.resetAssistantView(true);
  const view = state.ensureToolView(
    toolResultPart.toolCallId,
    toolResultPart.toolName
  );
  view.setOutput(toolResultPart.output);
};

export const handleToolError: StreamPartHandler = (part, state) => {
  const toolErrorPart = part as Extract<StreamPart, { type: "tool-error" }>;
  firePendingEndIfTracked(state, toolErrorPart.toolCallId);
  state.resetAssistantView(true);
  const view = state.ensureToolView(
    toolErrorPart.toolCallId,
    toolErrorPart.toolName
  );
  view.setError(toolErrorPart.error);
};

export const handleToolOutputDenied: StreamPartHandler = (part, state) => {
  const deniedPart = part as Extract<
    StreamPart,
    { type: "tool-output-denied" }
  >;
  firePendingEndIfTracked(state, deniedPart.toolCallId);
  state.resetAssistantView(true);
  const view = state.ensureToolView(deniedPart.toolCallId, deniedPart.toolName);
  view.setOutputDenied();
};

export const handleToolApprovalRequest: StreamPartHandler = (part, state) => {
  const approvalPart = part as StreamPart & {
    providerExecuted?: boolean;
    reason?: string;
    toolCallId: string;
    toolName: string;
  };

  firePendingEndIfTracked(state, approvalPart.toolCallId);
  state.resetAssistantView(true);
  const view = state.ensureToolView(
    approvalPart.toolCallId,
    approvalPart.toolName
  );

  const lines = [
    `**Tool** \`${approvalPart.toolName}\` (\`${approvalPart.toolCallId}\`)`,
    "**Approval required** before this tool can continue.",
  ];

  if (
    typeof approvalPart.reason === "string" &&
    approvalPart.reason.length > 0
  ) {
    lines.push(`**Reason** ${approvalPart.reason}`);
  }

  if (approvalPart.providerExecuted === false) {
    lines.push("**Status** waiting for user or policy decision");
  }

  view.setPrettyBlock(
    `**Approval** \`${approvalPart.toolName}\``,
    lines.join("\n\n")
  );
};

export const handleStartStep: StreamPartHandler = (_part, state) => {
  if (!state.flags.showSteps) {
    return;
  }

  state.resetAssistantView();
  addChatComponent(state.chatContainer, createInfoMessage("[step start]", ""));
};

export const handleFinishStep: StreamPartHandler = (part, state) => {
  if (!state.flags.showSteps) {
    return;
  }

  const finishStepPart = part as Extract<StreamPart, { type: "finish-step" }>;
  state.resetAssistantView();
  addChatComponent(
    state.chatContainer,
    createInfoMessage("[step finish]", finishStepPart.finishReason)
  );
};

export const handleSource: StreamPartHandler = (part, state) => {
  if (!state.flags.showSources) {
    return;
  }

  state.resetAssistantView();
  addChatComponent(state.chatContainer, createInfoMessage("[source]", part));
};

export const handleFile: StreamPartHandler = (part, state) => {
  if (!state.flags.showFiles) {
    return;
  }

  const filePart = part as Extract<StreamPart, { type: "file" }>;
  state.resetAssistantView();
  addChatComponent(
    state.chatContainer,
    createInfoMessage("[file]", filePart.file)
  );
};

export const handleFinish: StreamPartHandler = (part, state) => {
  if (!state.flags.showFinishReason) {
    return;
  }

  const finishPart = part as Extract<StreamPart, { type: "finish" }>;
  state.resetAssistantView();
  addChatComponent(
    state.chatContainer,
    createInfoMessage("[finish]", finishPart.finishReason ?? "unknown")
  );
};

export const STREAM_HANDLERS: Record<string, StreamPartHandler> = {
  "text-start": handleTextStart,
  "text-delta": handleTextDelta,
  "reasoning-start": handleReasoningStart,
  "reasoning-delta": handleReasoningDelta,
  "reasoning-end": handleReasoningEnd,
  "tool-input-start": handleToolInputStart,
  "tool-input-delta": handleToolInputDelta,
  "tool-input-end": handleToolInputEnd,
  "tool-call": handleToolCall,
  "tool-result": handleToolResult,
  "tool-error": handleToolError,
  "tool-output-denied": handleToolOutputDenied,
  "tool-approval-request": handleToolApprovalRequest,
  "start-step": handleStartStep,
  "finish-step": handleFinishStep,
  source: handleSource,
  file: handleFile,
  finish: handleFinish,
};

export const IGNORE_PART_TYPES = new Set(["abort", "text-end", "start"]);

export const isVisibleStreamPart = (
  part: StreamPart,
  flags: PiTuiRenderFlags
): boolean => {
  switch (part.type) {
    case "abort":
    case "text-end":
    case "reasoning-start":
    case "reasoning-delta":
    case "reasoning-end":
    case "start":
    case "tool-input-end":
      return false;
    case "text-start":
      return true;
    case "tool-result":
      return flags.showToolResults;
    case "start-step":
    case "finish-step":
      return flags.showSteps;
    case "source":
      return flags.showSources;
    case "file":
      return flags.showFiles;
    case "finish":
      return flags.showFinishReason;
    default:
      return true;
  }
};
