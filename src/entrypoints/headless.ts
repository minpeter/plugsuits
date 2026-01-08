#!/usr/bin/env bun

/**
 * Headless mode entry point for Harbor integration.
 * Usage: bun run src/entrypoints/headless.ts -p "instruction"
 */

import { agentManager, DEFAULT_MODEL_ID } from "../agent";
import { MessageHistory } from "../context/message-history";

interface TrajectoryEvent {
  timestamp: string;
  type: "user" | "assistant" | "tool_call" | "tool_result" | "error";
  sessionId: string;
  message?: {
    role: string;
    content: string | unknown[];
    model?: string;
    reasoning_content?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
    };
  };
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  };
  error?: string;
}

const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const startTime = Date.now();

const emitEvent = (event: TrajectoryEvent): void => {
  console.log(JSON.stringify(event));
};

const formatToolOutput = (output: unknown): string => {
  if (typeof output === "string") {
    return output;
  }
  if (typeof output === "object" && output !== null) {
    if ("output" in output) {
      const result = output as {
        output: string;
        error?: string;
        exitCode?: number;
      };
      let formatted = result.output || "";
      if (result.error) {
        formatted += `\nSTDERR: ${result.error}`;
      }
      if (result.exitCode !== undefined && result.exitCode !== 0) {
        formatted += `\nExit code: ${result.exitCode}`;
      }
      return formatted || JSON.stringify(output);
    }
    return JSON.stringify(output);
  }
  return String(output);
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
          type: "assistant",
          sessionId,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: part.toolCallId,
                name: part.toolName,
                input: part.input,
              },
            ],
            model: modelId,
            reasoning_content: currentReasoning || undefined,
          },
        });
        currentReasoning = "";
        break;
      case "tool-result":
        emitEvent({
          timestamp: new Date().toISOString(),
          type: "user",
          sessionId,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: part.toolCallId,
                content: formatToolOutput(part.output),
              },
            ],
          },
          toolUseResult: {
            stdout:
              typeof part.output === "object" &&
              part.output !== null &&
              "output" in part.output
                ? String((part.output as { output: unknown }).output)
                : String(part.output),
            exitCode:
              typeof part.output === "object" &&
              part.output !== null &&
              "exitCode" in part.output
                ? Number((part.output as { exitCode: unknown }).exitCode)
                : 0,
          },
        });
        break;
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
      message: {
        role: "assistant",
        content: currentText,
        model: modelId,
        reasoning_content: currentReasoning || undefined,
      },
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
    message: {
      role: "user",
      content: prompt,
    },
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
