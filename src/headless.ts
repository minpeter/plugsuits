#!/usr/bin/env bun

/**
 * Headless mode entry point for Harbor integration.
 * Usage: bun run src/headless.ts -p "instruction"
 */

import type { ToolApprovalResponse } from "ai";
import { agentManager } from "./agent";
import { MessageHistory } from "./context/message-history";

interface TrajectoryEvent {
  timestamp: string;
  type: "user" | "assistant" | "tool_call" | "tool_result" | "error";
  sessionId: string;
  message?: {
    role: string;
    content: string | unknown[];
    model?: string;
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

const parseArgs = (): { prompt: string } => {
  const args = process.argv.slice(2);
  let prompt = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-p" || args[i] === "--prompt") {
      prompt = args[i + 1] || "";
      i++;
    }
  }

  if (!prompt) {
    console.error("Usage: bun run src/headless.ts -p <prompt>");
    process.exit(1);
  }

  return { prompt };
};

const autoApproveAll = (
  requests: Array<{
    approvalId: string;
    toolCall: { toolName: string };
  }>
): ToolApprovalResponse[] => {
  return requests.map((req) => ({
    type: "tool-approval-response" as const,
    approvalId: req.approvalId,
    approved: true,
    reason: "Auto-approved in headless mode",
  }));
};

interface ApprovalRequest {
  type: "tool-approval-request";
  approvalId: string;
  toolCall: {
    toolName: string;
    toolCallId: string;
    input: unknown;
  };
}

const processAgentResponse = async (
  messageHistory: MessageHistory
): Promise<void> => {
  const stream = await agentManager.stream(messageHistory.toModelMessages());
  const approvalRequests: ApprovalRequest[] = [];

  let currentText = "";

  for await (const part of stream.fullStream) {
    switch (part.type) {
      case "text-delta":
        currentText += part.text;
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
            model: agentManager.getModelId(),
          },
        });
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
                content: String(part.output),
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
      case "tool-approval-request":
        approvalRequests.push(part);
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
        model: agentManager.getModelId(),
      },
    });
  }

  if (approvalRequests.length > 0) {
    const approvals = autoApproveAll(approvalRequests);
    messageHistory.addToolApprovalResponses(approvals);
    await processAgentResponse(messageHistory);
  }
};

const run = async (): Promise<void> => {
  const { prompt } = parseArgs();
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
