#!/usr/bin/env bun

import { agentManager, DEFAULT_MODEL_ID } from "../agent";
import { MessageHistory } from "../context/message-history";
import { setSessionId } from "../context/session";
import {
  MANUAL_TOOL_LOOP_MAX_STEPS,
  shouldContinueManualToolLoop,
} from "../interaction/tool-loop-control";
import {
  buildTodoContinuationUserMessage,
  getIncompleteTodos,
} from "../middleware/todo-continuation";
import {
  DEFAULT_REASONING_MODE,
  parseReasoningMode,
  type ReasoningMode,
} from "../reasoning-mode";
import {
  DEFAULT_TOOL_FALLBACK_MODE,
  LEGACY_ENABLED_TOOL_FALLBACK_MODE,
  parseToolFallbackMode,
  type ToolFallbackMode,
} from "../tool-fallback-mode";
import { cleanup } from "../tools/execute/process-manager";
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

const cleanupExecutionResources = (): void => {
  cleanup();
};

const exitWithCleanup = (code: number): never => {
  cleanupExecutionResources();
  process.exit(code);
};

process.once("exit", () => {
  cleanupExecutionResources();
});

process.once("SIGINT", () => {
  exitWithCleanup(0);
});

process.once("SIGTERM", () => {
  exitWithCleanup(143);
});

process.once("SIGHUP", () => {
  exitWithCleanup(129);
});

process.once("SIGQUIT", () => {
  exitWithCleanup(131);
});

process.once("uncaughtException", (error: unknown) => {
  console.error("Fatal error:", error);
  exitWithCleanup(1);
});

process.once("unhandledRejection", (reason: unknown) => {
  console.error("Unhandled rejection:", reason);
  exitWithCleanup(1);
});

const startTime = Date.now();

const emitEvent = (event: TrajectoryEvent): void => {
  console.log(JSON.stringify(event));
};

const parseToolFallbackCliOption = (
  args: string[],
  index: number
): { consumedArgs: number; mode: ToolFallbackMode } | null => {
  const arg = args[index];

  if (arg === "--tool-fallback-mode") {
    const candidate = args[index + 1];
    if (!candidate || candidate.startsWith("--")) {
      return {
        consumedArgs: 0,
        mode: DEFAULT_TOOL_FALLBACK_MODE,
      };
    }
    const parsedMode = parseToolFallbackMode(candidate);
    return {
      consumedArgs: 1,
      mode: parsedMode ?? DEFAULT_TOOL_FALLBACK_MODE,
    };
  }

  if (arg !== "--tool-fallback") {
    return null;
  }

  const candidate = args[index + 1];
  if (candidate && !candidate.startsWith("--")) {
    const parsedMode = parseToolFallbackMode(candidate);
    return {
      consumedArgs: 1,
      mode: parsedMode ?? LEGACY_ENABLED_TOOL_FALLBACK_MODE,
    };
  }

  return {
    consumedArgs: 0,
    mode: LEGACY_ENABLED_TOOL_FALLBACK_MODE,
  };
};

const parseArgs = (): {
  prompt: string;
  model?: string;
  reasoningMode: ReasoningMode;
  toolFallbackMode: ToolFallbackMode;
} => {
  const args = process.argv.slice(2);
  let prompt = "";
  let model: string | undefined;
  let reasoningMode: ReasoningMode = DEFAULT_REASONING_MODE;
  let toolFallbackMode: ToolFallbackMode = DEFAULT_TOOL_FALLBACK_MODE;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-p" || arg === "--prompt") {
      prompt = args[i + 1] || "";
      i++;
    } else if (arg === "-m" || arg === "--model") {
      model = args[i + 1] || undefined;
      i++;
    } else if (arg === "--think") {
      reasoningMode = "on";
    } else if (arg === "--reasoning-mode") {
      const candidate = args[i + 1];
      if (candidate && !candidate.startsWith("--")) {
        const parsedMode = parseReasoningMode(candidate);
        reasoningMode = parsedMode ?? DEFAULT_REASONING_MODE;
        i++;
      }
    } else {
      const toolFallbackOption = parseToolFallbackCliOption(args, i);
      if (toolFallbackOption) {
        toolFallbackMode = toolFallbackOption.mode;
        i += toolFallbackOption.consumedArgs;
      }
    }
  }

  if (!prompt) {
    console.error(
      "Usage: bun run src/entrypoints/headless.ts -p <prompt> [-m <model>] [--think] [--reasoning-mode <off|on|interleaved|preserved>] [--tool-fallback [mode]] [--tool-fallback-mode <mode>]"
    );
    process.exit(1);
  }

  return { prompt, model, reasoningMode, toolFallbackMode };
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
  const modelId = agentManager.getModelId();
  let manualToolLoopCount = 0;

  while (true) {
    const stream = await agentManager.stream(messageHistory.toModelMessages());

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
          const finishPart = part as Extract<
            typeof part,
            { type: "finish-step" }
          >;
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

    const [response, finishReason] = await Promise.all([
      stream.response,
      stream.finishReason,
    ]);
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

    if (!shouldContinueManualToolLoop(finishReason)) {
      return;
    }

    manualToolLoopCount += 1;
    if (manualToolLoopCount >= MANUAL_TOOL_LOOP_MAX_STEPS) {
      emitEvent({
        timestamp: new Date().toISOString(),
        type: "error",
        sessionId,
        error: `Manual tool loop safety cap reached (${MANUAL_TOOL_LOOP_MAX_STEPS}).`,
      });
      return;
    }
  }
};

const run = async (): Promise<void> => {
  await initializeTools();

  const { prompt, model, reasoningMode, toolFallbackMode } = parseArgs();

  setSessionId(sessionId);

  agentManager.setHeadlessMode(true);
  agentManager.setModelId(model || DEFAULT_MODEL_ID);
  agentManager.setReasoningMode(reasoningMode);
  agentManager.setToolFallbackMode(toolFallbackMode);

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

    const MAX_TODO_REMINDER_ITERATIONS = 20;
    let todoReminderCount = 0;

    while (true) {
      const incompleteTodos = await getIncompleteTodos();
      if (incompleteTodos.length === 0) {
        break;
      }

      todoReminderCount += 1;
      if (todoReminderCount > MAX_TODO_REMINDER_ITERATIONS) {
        emitEvent({
          timestamp: new Date().toISOString(),
          type: "error",
          sessionId,
          error: `Todo continuation safety cap reached (${MAX_TODO_REMINDER_ITERATIONS} reminders). Incomplete todos: ${incompleteTodos.map((t) => t.id).join(", ")}`,
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
      await processAgentResponse(messageHistory);
    }
  } catch (error) {
    emitEvent({
      timestamp: new Date().toISOString(),
      type: "error",
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    exitWithCleanup(1);
  }

  cleanupExecutionResources();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.error(`[headless] Completed in ${elapsed}s`);
};

run().catch((error: unknown) => {
  console.error("Fatal error:", error);
  exitWithCleanup(1);
});
