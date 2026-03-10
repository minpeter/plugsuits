import {
  type AgentConfig,
  type AgentStreamResult,
  createAgent,
  MessageHistory,
  type ModelMessage,
  SessionManager,
} from "@ai-sdk-tool/harness";
import { emitEvent, runHeadless } from "@ai-sdk-tool/headless";
import { createAgentTUI } from "@ai-sdk-tool/tui";
import { defineCommand, runMain } from "citty";

function getLastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "user") {
      continue;
    }
    if (typeof msg.content === "string") {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter(
          (p): p is { type: "text"; text: string } =>
            typeof p === "object" &&
            p !== null &&
            "type" in p &&
            p.type === "text" &&
            "text" in p &&
            typeof p.text === "string"
        )
        .map((p) => p.text)
        .join(" ")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function createEchoStream(messages: ModelMessage[]): AgentStreamResult {
  const userText = getLastUserText(messages) || "(empty input)";
  const reply = `Echo: ${userText}`;
  const usage = Promise.resolve({
    inputTokens: 0,
    inputTokenDetails: {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
    },
    outputTokens: 0,
    outputTokenDetails: {
      reasoningTokens: 0,
      textTokens: 0,
    },
    raw: undefined,
    totalTokens: 0,
  }) as AgentStreamResult["usage"];

  return {
    fullStream: new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue({ type: "text-delta", text: reply });
        controller.enqueue({ type: "finish-step", finishReason: "stop" });
        controller.close();
      },
    }) as unknown as AgentStreamResult["fullStream"],
    finishReason: Promise.resolve("stop") as AgentStreamResult["finishReason"],
    response: Promise.resolve({
      id: "echo-response",
      timestamp: new Date(),
      modelId: "mock-echo",
      messages: [{ role: "assistant", content: reply }],
    } as unknown) as AgentStreamResult["response"],
    totalUsage: usage as AgentStreamResult["totalUsage"],
    usage,
  };
}

const main = defineCommand({
  meta: { name: "minimal-agent", description: "Minimal echo agent example" },
  args: {
    headless: {
      type: "boolean",
      description: "Run in headless JSONL mode",
    },
    prompt: {
      type: "string",
      description: "User prompt (required for --headless)",
    },
  },
  async run({ args }) {
    const messageHistory = new MessageHistory();
    const sessionManager = new SessionManager("minimal-agent");
    const sessionId = sessionManager.initialize();

    const baseAgent = createAgent({
      model: {} as AgentConfig["model"],
      instructions: "You are a minimal echo agent.",
    });

    const echoAgent = {
      config: baseAgent.config,
      stream: (messages: unknown[]): Promise<AgentStreamResult> =>
        Promise.resolve(createEchoStream(messages as ModelMessage[])),
    };

    if (args.headless) {
      const prompt = args.prompt?.trim();
      if (!prompt) {
        console.error("--headless requires --prompt <text>");
        process.exitCode = 1;
        return;
      }

      emitEvent({
        timestamp: new Date().toISOString(),
        type: "user",
        sessionId,
        content: prompt,
      });
      messageHistory.addUserMessage(prompt);

      await runHeadless({
        sessionId,
        emitEvent,
        getModelId: () => "mock-echo",
        messageHistory,
        maxIterations: 1,
        stream: (messages) => echoAgent.stream(messages as ModelMessage[]),
      });
      return;
    }

    await createAgentTUI({
      agent: echoAgent,
      messageHistory,
      header: {
        title: "Minimal Agent",
        subtitle: `Session: ${sessionId}`,
      },
    });

    process.exit(0);
  },
});

runMain(main);
