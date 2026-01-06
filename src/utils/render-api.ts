import type { ModelMessage, ToolModelMessage, ToolResultPart } from "ai";
import { env } from "../env";
import { tools } from "../tools/index";

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface SchemaWithToJSON {
  toJSONSchema: () => Record<string, unknown>;
}

export interface RenderAPIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface RenderApiOptions {
  onError?: (message: string) => void;
}

const extractTextContent = (
  parts: Array<{ type: string; text?: string }>
): string => {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
};

const determineAssistantContent = (
  textParts: Array<{ type: string; text?: string }>,
  hasToolCalls: boolean
): string | null => {
  if (textParts.length > 0) {
    return extractTextContent(textParts);
  }
  if (hasToolCalls) {
    return null;
  }
  return "";
};

const convertUserMessage = (msg: ModelMessage): RenderAPIMessage => {
  const content = Array.isArray(msg.content)
    ? extractTextContent(msg.content)
    : msg.content;
  return { role: "user", content };
};

const convertAssistantMessage = (msg: ModelMessage): RenderAPIMessage => {
  const contentArray = Array.isArray(msg.content) ? msg.content : [];
  const textParts = contentArray.filter((part) => part.type === "text");
  const toolCallParts = contentArray.filter(
    (part) => part.type === "tool-call"
  );

  const content = determineAssistantContent(
    textParts,
    toolCallParts.length > 0
  );
  const assistantMsg: RenderAPIMessage = { role: "assistant", content };

  if (toolCallParts.length > 0) {
    assistantMsg.tool_calls = toolCallParts.map((toolCall) => ({
      id: toolCall.toolCallId,
      type: "function" as const,
      function: {
        name: toolCall.toolName,
        arguments: JSON.stringify(toolCall.input),
      },
    }));
  }

  return assistantMsg;
};

const convertToolMessages = (msg: ToolModelMessage): RenderAPIMessage[] => {
  const results: RenderAPIMessage[] = [];
  for (const part of msg.content) {
    if (part.type === "tool-result") {
      const resultPart = part as ToolResultPart;
      const content =
        typeof resultPart.output === "string"
          ? resultPart.output
          : JSON.stringify(resultPart.output);
      results.push({
        role: "tool",
        content,
        tool_call_id: resultPart.toolCallId,
      });
    }
  }
  return results;
};

export const convertToRenderAPIMessages = (
  messages: ModelMessage[],
  systemPrompt: string
): RenderAPIMessage[] => {
  const result: RenderAPIMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push(convertUserMessage(msg));
    } else if (msg.role === "assistant") {
      result.push(convertAssistantMessage(msg));
    } else if (msg.role === "tool") {
      result.push(...convertToolMessages(msg as ToolModelMessage));
    }
  }

  return result;
};

export const convertToolsToOpenAIFormat = (): OpenAITool[] => {
  return Object.entries(tools).map(([name, tool]) => {
    const schema = tool.inputSchema as unknown as SchemaWithToJSON;
    return {
      type: "function" as const,
      function: {
        name,
        description: tool.description ?? "",
        parameters: schema.toJSONSchema(),
      },
    };
  });
};

export const fetchRenderedText = async (
  messages: RenderAPIMessage[],
  modelId: string,
  includeTools = false,
  options: RenderApiOptions = {}
): Promise<string | null> => {
  const body: Record<string, unknown> = {
    model: modelId,
    messages,
  };

  if (includeTools) {
    body.tools = convertToolsToOpenAIFormat();
  }

  const response = await fetch(
    "https://api.friendli.ai/serverless/v1/chat/render",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.FRIENDLI_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    options.onError?.(`Render API failed: ${error}`);
    return null;
  }

  const data = (await response.json()) as { text: string };
  return data.text;
};

export const fetchTokenCount = async (
  text: string,
  modelId: string,
  options: RenderApiOptions = {}
): Promise<number | null> => {
  const response = await fetch(
    "https://api.friendli.ai/serverless/v1/tokenize",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.FRIENDLI_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        prompt: text,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    options.onError?.(`Tokenize API failed: ${error}`);
    return null;
  }

  const data = (await response.json()) as { tokens: number[] };
  return data.tokens.length;
};

export const measureContextTokens = async (
  messages: ModelMessage[],
  modelId: string,
  systemPrompt: string,
  options: RenderApiOptions = {}
): Promise<number | null> => {
  const apiMessages = convertToRenderAPIMessages(messages, systemPrompt);
  const renderedText = await fetchRenderedText(
    apiMessages,
    modelId,
    true,
    options
  );
  if (renderedText === null) {
    return null;
  }
  return fetchTokenCount(renderedText, modelId, options);
};
