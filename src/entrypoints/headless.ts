#!/usr/bin/env bun

import { agentManager, DEFAULT_MODEL_ID } from "../agent";
import { MessageHistory } from "../context/message-history";
import { setSessionId } from "../context/session";
import { env } from "../env";
import {
  buildTodoContinuationUserMessage,
  getIncompleteTodos,
} from "../middleware/todo-continuation";
import { cleanupSession } from "../tools/execute/shared-tmux-session";
import { initializeTools } from "../utils/tools-manager";

interface BaseEvent {
  sessionId: string;
  timestamp: string;
}

interface UserEvent extends BaseEvent {
  content: string;
  type: "user";
}

interface AssistantEvent extends BaseEvent {
  content: string;
  model: string;
  reasoning_content?: string;
  type: "assistant";
}

interface ToolCallEvent extends BaseEvent {
  model: string;
  reasoning_content?: string;
  tool_call_id: string;
  tool_input: Record<string, unknown>;
  tool_name: string;
  type: "tool_call";
}

interface ToolResultEvent extends BaseEvent {
  error?: string;
  exit_code?: number;
  output: string;
  tool_call_id: string;
  type: "tool_result";
}

interface ErrorEvent extends BaseEvent {
  error: string;
  type: "error";
}

type TrajectoryEvent =
  | UserEvent
  | AssistantEvent
  | ToolCallEvent
  | ToolResultEvent
  | ErrorEvent;

const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

process.on("SIGINT", () => {
  process.exit(0);
});

const startTime = Date.now();
const TODO_CONTINUATION_MAX_LOOPS = 5;

const emitEvent = (event: TrajectoryEvent): void => {
  console.log(JSON.stringify(event));
};

const parseArgs = (): {
  prompt: string;
  model?: string;
  thinking: boolean;
  toolFallback: boolean;
} => {
  const args = process.argv.slice(2);
  let prompt = "";
  let model: string | undefined;
  let thinking = false;
  let toolFallback = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-p" || args[i] === "--prompt") {
      prompt = args[i + 1] || "";
      i++;
    } else if (args[i] === "-m" || args[i] === "--model") {
      model = args[i + 1] || undefined;
      i++;
    } else if (args[i] === "--think") {
      thinking = true;
    } else if (args[i] === "--tool-fallback") {
      toolFallback = true;
    }
  }

  if (!prompt) {
    console.error(
      "Usage: bun run src/entrypoints/headless.ts -p <prompt> [-m <model>] [--think] [--tool-fallback]"
    );
    process.exit(1);
  }

  return { prompt, model, thinking, toolFallback };
};

const extractToolOutput = (
  output: unknown
): { stdout: string; error?: string; exitCode?: number } => {
  if (typeof output === "object" && output !== null && "output" in output) {
    const result = output as {
      output: string;
      error?: string;
      exit_code?: number;
    };
    return {
      stdout: result.output || "",
      error: result.error,
      exitCode: result.exit_code,
    };
  }
  return { stdout: String(output) };
};

const getToolInputChunk = (part: {
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

const getToolInputId = (part: {
  id?: string;
  toolCallId?: string;
}): string | undefined => part.id ?? part.toolCallId;

interface PendingToolCall {
  arguments: string;
  id: string;
}

const handleToolInputStart = (
  pendingToolCalls: Map<string, PendingToolCall>,
  part: {
    id?: string;
    toolCallId?: string;
  }
): void => {
  const id = getToolInputId(part);
  if (!id) {
    return;
  }

  pendingToolCalls.set(id, {
    id,
    arguments: "",
  });
};

const handleToolInputDelta = (
  pendingToolCalls: Map<string, PendingToolCall>,
  part: {
    delta?: unknown;
    id?: string;
    inputTextDelta?: unknown;
    toolCallId?: string;
  }
): void => {
  const toolCallId = getToolInputId(part);
  const toolCallDelta = getToolInputChunk(part);

  if (!toolCallId || toolCallDelta === null) {
    return;
  }

  const existing = pendingToolCalls.get(toolCallId);
  if (existing) {
    existing.arguments += toolCallDelta;
    return;
  }

  pendingToolCalls.set(toolCallId, {
    id: toolCallId,
    arguments: toolCallDelta,
  });
};

const emitToolCallEvent = (
  completedToolCallIds: Set<string>,
  modelId: string,
  reasoningContent: string,
  part: {
    input: unknown;
    toolCallId: string;
    toolName: string;
  }
): string => {
  completedToolCallIds.add(part.toolCallId);
  emitEvent({
    timestamp: new Date().toISOString(),
    type: "tool_call",
    sessionId,
    tool_call_id: part.toolCallId,
    tool_name: part.toolName,
    tool_input: part.input as Record<string, unknown>,
    model: modelId,
    reasoning_content: reasoningContent || undefined,
  });
  return "";
};

const emitToolResultEvent = (part: {
  output: unknown;
  toolCallId: string;
}): void => {
  const toolOutput = extractToolOutput(part.output);
  emitEvent({
    timestamp: new Date().toISOString(),
    type: "tool_result",
    sessionId,
    tool_call_id: part.toolCallId,
    output: toolOutput.stdout,
    error: toolOutput.error,
    exit_code: toolOutput.exitCode,
  });
};

const emitToolErrorEvent = (part: {
  error: unknown;
  toolCallId: string;
}): void => {
  emitEvent({
    timestamp: new Date().toISOString(),
    type: "tool_result",
    sessionId,
    tool_call_id: part.toolCallId,
    output: "",
    error:
      part.error instanceof Error ? part.error.message : String(part.error),
    exit_code: 1,
  });
};

const emitMalformedToolCallErrors = (
  completedToolCallIds: Set<string>,
  pendingToolCalls: Map<string, PendingToolCall>
): void => {
  for (const [id, pending] of pendingToolCalls) {
    if (completedToolCallIds.has(id)) {
      continue;
    }

    emitEvent({
      timestamp: new Date().toISOString(),
      type: "error",
      sessionId,
      error: `Tool call failed: malformed JSON in tool arguments (id: ${id}). Raw arguments: ${pending.arguments.slice(0, 500)}`,
    });
  }
};

const emitMalformedToolCallsSummary = (
  completedToolCallIds: Set<string>,
  lastFinishReason: string | undefined,
  pendingToolCalls: Map<string, PendingToolCall>
): void => {
  if (
    lastFinishReason !== "tool-calls" ||
    pendingToolCalls.size === 0 ||
    completedToolCallIds.size > 0
  ) {
    return;
  }

  emitEvent({
    timestamp: new Date().toISOString(),
    type: "error",
    sessionId,
    error:
      "Model attempted tool calls but all failed due to malformed JSON. This is likely a model bug with JSON escaping in tool arguments.",
  });
};

const processAgentResponse = async (
  messageHistory: MessageHistory
): Promise<void> => {
  const stream = await agentManager.stream(messageHistory.toModelMessages());
  const modelId = agentManager.getModelId();

  let currentText = "";
  let currentReasoning = "";
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const completedToolCallIds = new Set<string>();
  let lastFinishReason: string | undefined;

  for await (const part of stream.fullStream) {
    switch (part.type) {
      case "text-delta":
        currentText += part.text;
        break;
      case "reasoning-delta":
        currentReasoning += part.text;
        break;
      case "tool-input-start":
        handleToolInputStart(pendingToolCalls, part);
        break;
      case "tool-input-delta":
        handleToolInputDelta(pendingToolCalls, part);
        break;
      case "tool-input-end":
        break;
      case "tool-call":
        currentReasoning = emitToolCallEvent(
          completedToolCallIds,
          modelId,
          currentReasoning,
          part
        );
        break;
      case "tool-result":
        emitToolResultEvent(part);
        break;
      case "tool-error":
        emitToolErrorEvent(part);
        break;
      case "finish-step": {
        const finishPart = part as { finishReason: string };
        lastFinishReason = finishPart.finishReason;
        break;
      }
      default:
        break;
    }
  }

  emitMalformedToolCallErrors(completedToolCallIds, pendingToolCalls);
  emitMalformedToolCallsSummary(
    completedToolCallIds,
    lastFinishReason,
    pendingToolCalls
  );

  const response = await stream.response;
  messageHistory.addModelMessages(response.messages);

  if (currentText.trim()) {
    emitEvent({
      timestamp: new Date().toISOString(),
      type: "assistant",
      sessionId,
      content: currentText,
      model: modelId,
      reasoning_content: currentReasoning || undefined,
    });
  }
};

const run = async (): Promise<void> => {
  // Initialize required tools (ripgrep, tmux)
  await initializeTools();

  const { prompt, model, thinking, toolFallback } = parseArgs();

  setSessionId(sessionId);

  agentManager.setHeadlessMode(true);
  agentManager.setModelId(model || DEFAULT_MODEL_ID);
  agentManager.setThinkingEnabled(thinking);
  agentManager.setToolFallbackEnabled(toolFallback);

  const messageHistory = new MessageHistory();

  emitEvent({
    timestamp: new Date().toISOString(),
    type: "user",
    sessionId,
    content: prompt,
  });

  messageHistory.addUserMessage(prompt);

  try {
    await processAgentResponse(messageHistory);

    let continuationCount = 0;
    while (continuationCount <= TODO_CONTINUATION_MAX_LOOPS) {
      const incompleteTodos = await getIncompleteTodos();
      if (incompleteTodos.length === 0) {
        break;
      }

      if (continuationCount === TODO_CONTINUATION_MAX_LOOPS) {
        emitEvent({
          timestamp: new Date().toISOString(),
          type: "error",
          sessionId,
          error:
            "Auto-continue limit reached with incomplete todos. Awaiting new input.",
        });
        break;
      }

      const reminder = buildTodoContinuationUserMessage(incompleteTodos);
      emitEvent({
        timestamp: new Date().toISOString(),
        type: "user",
        sessionId,
        content: reminder,
      });
      messageHistory.addUserMessage(reminder);
      continuationCount += 1;
      await processAgentResponse(messageHistory);
    }
  } catch (error) {
    emitEvent({
      timestamp: new Date().toISOString(),
      type: "error",
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (env.TMUX_CLEANUP_SESSION) {
      cleanupSession();
    }
    process.exit(1);
  }

  if (env.TMUX_CLEANUP_SESSION) {
    cleanupSession();
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.error(`[headless] Completed in ${elapsed}s`);
};

run().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
