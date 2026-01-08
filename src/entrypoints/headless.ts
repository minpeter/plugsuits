#!/usr/bin/env bun

import { agentManager, DEFAULT_MODEL_ID } from "../agent";
import { MessageHistory } from "../context/message-history";

interface BaseEvent {
  timestamp: string;
  sessionId: string;
}

interface UserEvent extends BaseEvent {
  type: "user";
  content: string;
}

interface AssistantEvent extends BaseEvent {
  type: "assistant";
  content: string;
  model: string;
  reasoning_content?: string;
}

interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  tool_call_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  model: string;
  reasoning_content?: string;
}

interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  tool_call_id: string;
  output: string;
  error?: string;
  exit_code?: number;
}

interface ErrorEvent extends BaseEvent {
  type: "error";
  error: string;
}

type TrajectoryEvent =
  | UserEvent
  | AssistantEvent
  | ToolCallEvent
  | ToolResultEvent
  | ErrorEvent;

const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const startTime = Date.now();

const emitEvent = (event: TrajectoryEvent): void => {
  console.log(JSON.stringify(event));
};

const parseArgs = (): { prompt: string; model?: string } => {
  const args = process.argv.slice(2);
  let prompt = "";
  let model: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-p" || args[i] === "--prompt") {
      prompt = args[i + 1] || "";
      i++;
    } else if (args[i] === "-m" || args[i] === "--model") {
      model = args[i + 1] || undefined;
      i++;
    }
  }

  if (!prompt) {
    console.error(
      "Usage: bun run src/entrypoints/headless.ts -p <prompt> [-m <model>]"
    );
    process.exit(1);
  }

  return { prompt, model };
};

const extractToolOutput = (
  output: unknown
): { stdout: string; error?: string; exitCode?: number } => {
  if (typeof output === "object" && output !== null && "output" in output) {
    const result = output as {
      output: string;
      error?: string;
      exitCode?: number;
    };
    return {
      stdout: result.output || "",
      error: result.error,
      exitCode: result.exitCode,
    };
  }
  return { stdout: String(output) };
};

const processAgentResponse = async (
  messageHistory: MessageHistory
): Promise<void> => {
  const stream = await agentManager.stream(messageHistory.toModelMessages());
  const modelId = agentManager.getModelId();

  let currentText = "";
  let currentReasoning = "";

  for await (const part of stream.fullStream) {
    switch (part.type) {
      case "text-delta":
        currentText += part.text;
        break;
      case "reasoning-delta":
        currentReasoning += part.text;
        break;
      case "tool-call":
        emitEvent({
          timestamp: new Date().toISOString(),
          type: "tool_call",
          sessionId,
          tool_call_id: part.toolCallId,
          tool_name: part.toolName,
          tool_input: part.input as Record<string, unknown>,
          model: modelId,
          reasoning_content: currentReasoning || undefined,
        });
        currentReasoning = "";
        break;
      case "tool-result": {
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
        break;
      }
      default:
        break;
    }
  }

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
  const { prompt, model } = parseArgs();

  agentManager.setHeadlessMode(true);
  agentManager.setModelId(model || DEFAULT_MODEL_ID);

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
  } catch (error) {
    emitEvent({
      timestamp: new Date().toISOString(),
      type: "error",
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.error(`[headless] Completed in ${elapsed}s`);
};

run().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
