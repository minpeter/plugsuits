import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelMessage, ToolSet } from "ai";
import { generateText } from "ai";
import { env } from "../env";
import type { Command, CommandResult } from "./types";

const customFetch = Object.assign(
  async (_url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const parsedBody = options?.body ? JSON.parse(options.body as string) : {};
    const { tool_choice: _ignored, ...bodyWithoutToolChoice } = parsedBody;

    const resp = await fetch(
      "https://api.friendli.ai/serverless/v1/chat/render",
      {
        ...options,
        body: JSON.stringify({
          ...bodyWithoutToolChoice,
          chat_template_kwargs: {
            enable_thinking: true,
          },
        }),
      }
    );

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`API error ${resp.status}: ${errorText}`);
    }

    const data = (await resp.json()) as { text: string };

    const result = {
      id: "chatcmpl-render",
      model: "dummy",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: data.text,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      created: Date.now(),
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
  { preconnect: fetch.preconnect }
);

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
  fetch: customFetch,
});

interface RenderData {
  model: string;
  instructions: string;
  tools: ToolSet;
  messages: ModelMessage[];
}

async function renderChatPrompt({
  model,
  instructions,
  tools,
  messages,
}: RenderData): Promise<string> {
  const result = await generateText({
    model: friendli(model),
    system: instructions,
    tools,
    messages,
  });

  return result.text;
}

const RENDER_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ]);
}

export const createRenderCommand = (getData: () => RenderData): Command => ({
  name: "render",
  description: "Render conversation as raw prompt text",
  execute: async (): Promise<CommandResult> => {
    const data = getData();

    if (data.messages.length === 0) {
      return { success: false, message: "No messages to render." };
    }

    try {
      const text = await withTimeout(renderChatPrompt(data), RENDER_TIMEOUT_MS);
      return { success: true, message: text || "(empty render result)" };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return { success: false, message: `Render failed: ${errorMessage}` };
    }
  },
});
