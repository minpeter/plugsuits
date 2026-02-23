import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelMessage, ToolSet } from "ai";
import { generateText, wrapLanguageModel } from "ai";
import type { ModelType } from "../agent";
import { env } from "../env";
import { colors } from "../interaction/colors";
import { Spinner } from "../interaction/spinner";
import { buildMiddlewares } from "../middleware";
import type { ToolFallbackMode } from "../tool-fallback-mode";
import type { Command, CommandResult } from "./types";

interface RenderData {
  instructions: string;
  messages: ModelMessage[];
  model: string;
  modelType: ModelType;
  thinkingEnabled: boolean;
  toolFallbackMode: ToolFallbackMode;
  tools: ToolSet;
}

/**
 * Render chat prompt to raw text.
 *
 * Why use generateText + capturedText pattern:
 * - Request: Must go through AI SDK middleware and conversion layer
 *   to match actual API request format (tool definitions, message format, etc.)
 * - Response: Must show raw text AS-IS, but AI SDK parses XML tool calls
 *   and strips them from result.text
 *
 * Solution: Capture raw API response before AI SDK processes it,
 * return empty content to AI SDK so it has nothing to parse.
 */
async function renderChatPrompt({
  model,
  modelType,
  instructions,
  tools,
  messages,
  thinkingEnabled,
  toolFallbackMode,
}: RenderData): Promise<string> {
  const isDedicated = modelType === "dedicated";
  const baseURL = isDedicated
    ? "https://api.friendli.ai/dedicated/v1"
    : "https://api.friendli.ai/serverless/v1";

  let capturedText = "";

  const customFetch = Object.assign(
    async (
      _url: RequestInfo | URL,
      options?: RequestInit
    ): Promise<Response> => {
      const parsedBody = options?.body
        ? JSON.parse(options.body as string)
        : {};
      const { tool_choice: _ignored, ...bodyWithoutToolChoice } = parsedBody;

      const endpoint = isDedicated
        ? "https://api.friendli.ai/dedicated/v1/chat/render"
        : "https://api.friendli.ai/serverless/v1/chat/render";

      const resp = await fetch(endpoint, {
        ...options,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...options?.headers,
        },
        body: JSON.stringify({
          ...bodyWithoutToolChoice,
          chat_template_kwargs: {
            enable_thinking: thinkingEnabled,
            thinking: thinkingEnabled,
          },
        }),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`API error ${resp.status}: ${errorText}`);
      }

      const data = (await resp.json()) as { text: string };
      capturedText = data.text;

      const result = {
        id: "chatcmpl-render",
        model: "dummy",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
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
    baseURL,
    fetch: customFetch,
  });

  await generateText({
    model: wrapLanguageModel({
      model: friendli(model),
      middleware: buildMiddlewares({
        toolFallbackMode,
      }),
    }),
    system: instructions,
    tools,
    messages,
  });

  return capturedText;
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

export const createRenderCommand = (
  getData: () => RenderData | Promise<RenderData>
): Command => ({
  name: "render",
  description: "Render conversation as raw prompt text",
  execute: async (): Promise<CommandResult> => {
    const spinner = new Spinner("Rendering prompt...");
    const data = await getData();

    if (data.messages.length === 0) {
      return { success: false, message: "No messages to render." };
    }

    try {
      spinner.start();
      const text = await withTimeout(renderChatPrompt(data), RENDER_TIMEOUT_MS);
      spinner.stop();
      const styledText = text
        ? `${colors.dim}${text}${colors.reset}`
        : "(empty render result)";
      return { success: true, message: styledText };
    } catch (error) {
      spinner.stop();
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return { success: false, message: `Render failed: ${errorMessage}` };
    }
  },
});
