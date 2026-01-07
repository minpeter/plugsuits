import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelMessage, ToolSet } from "ai";
import { generateText } from "ai";
import { env } from "../env";

const customFetch = Object.assign(
  async (_url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const resp = await fetch(
      "https://api.friendli.ai/serverless/v1/chat/render",
      {
        ...options,
        body: JSON.stringify({
          ...(options?.body ? JSON.parse(options.body as string) : {}),
          chat_template_kwargs: {
            enable_thinking: true,
          },
        }),
      }
    );

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

export async function renderChatPrompt({
  model,
  instructions,
  tools,
  messages,
}: {
  model: string;
  instructions: string;
  tools: ToolSet;
  messages: ModelMessage[];
}): Promise<string> {
  const result = await generateText({
    model: friendli(model),
    system: instructions,
    tools,
    messages,
  });

  return result.text;
}
