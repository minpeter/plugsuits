import type { ModelMessage, TextPart, ToolSet } from "ai";

// Constants for token estimation
export const LATIN_CHARS_PER_TOKEN = 4;
export const CJK_CHARS_PER_TOKEN = 1.5;
export const TOOL_RESULT_CHARS_PER_TOKEN = 6;
export const TOOL_CALL_CHARS_PER_TOKEN = 6;

// CJK Unicode ranges for improved token estimation
const CJK_REGEX =
  /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3100-\u312F\u3130-\u318F\u3200-\u32FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF]/g;

/**
 * Improved token estimator that accounts for CJK characters.
 * CJK characters typically map to ~1-2 tokens each (vs ~4 chars/token for Latin).
 */
export function estimateTokens(text: string): number {
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = text.length - cjkCount;

  const cjkTokens = cjkCount / CJK_CHARS_PER_TOKEN;
  const nonCjkTokens = nonCjkCount / LATIN_CHARS_PER_TOKEN;

  return Math.ceil(cjkTokens + nonCjkTokens);
}

/**
 * Extract text content from a message for token estimation.
 */
export function extractMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .map((part) => {
      if (typeof part === "object" && part !== null) {
        if (part.type === "text") {
          return (part as TextPart).text;
        }
        if (part.type === "tool-call") {
          return `${part.toolName} ${JSON.stringify(part.input)}`;
        }
        if (part.type === "tool-result") {
          return `${part.toolName} ${JSON.stringify(part.output)}`;
        }
      }
      return "";
    })
    .join(" ");
}

function extractRawTextLength(output: unknown, depth = 0): number {
  if (output == null) {
    return 0;
  }

  if (typeof output === "string") {
    return output.length;
  }

  if (typeof output === "object" && depth < 5) {
    const obj = output as Record<string, unknown>;

    if (typeof obj.value === "string") {
      return obj.value.length;
    }

    if (typeof obj.text === "string") {
      return obj.text.length;
    }

    let total = 0;

    for (const value of Object.values(obj)) {
      if (value != null && typeof value !== "object") {
        if (typeof value === "string") {
          total += value.length;
        }
      } else {
        total += extractRawTextLength(value, depth + 1);
      }
    }

    return total;
  }

  return 0;
}

function estimateToolRoleMessageTokens(message: ModelMessage): number {
  if (!Array.isArray(message.content)) {
    return estimateTokens(message.content as string);
  }

  let totalTokens = 0;

  for (const part of message.content) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "tool-result"
    ) {
      const rawLen = extractRawTextLength((part as { output: unknown }).output);
      totalTokens += Math.ceil(rawLen / TOOL_RESULT_CHARS_PER_TOKEN);
    }
  }

  return totalTokens;
}

function estimateArrayContentTokens(parts: ModelMessage["content"]): number {
  if (!Array.isArray(parts)) {
    return 0;
  }

  let totalTokens = 0;

  for (const part of parts) {
    if (typeof part !== "object" || part === null) {
      continue;
    }

    if (part.type === "text") {
      totalTokens += estimateTokens((part as TextPart).text);
      continue;
    }

    if (part.type === "tool-call") {
      const rawLen = part.toolName.length + extractRawTextLength(part.input);
      totalTokens += Math.ceil(rawLen / TOOL_CALL_CHARS_PER_TOKEN);
      continue;
    }

    if (part.type === "tool-result") {
      const rawLen = extractRawTextLength(part.output);
      totalTokens += Math.ceil(rawLen / TOOL_RESULT_CHARS_PER_TOKEN);
    }
  }

  return totalTokens;
}

/**
 * Estimate token count for a ModelMessage, with content-type-aware weighting.
 * Tool-call and tool-result parts use raw text length (no JSON.stringify inflation)
 * with chars/4 ratio (same as plain text).
 */
export function estimateMessageTokens(message: ModelMessage): number {
  if (typeof message.content === "string") {
    return estimateTokens(message.content);
  }

  if (message.role === "tool") {
    return estimateToolRoleMessageTokens(message);
  }

  if (Array.isArray(message.content)) {
    return estimateArrayContentTokens(message.content);
  }

  return estimateTokens(extractMessageText(message));
}

export function estimateToolSchemasTokens(tools: ToolSet): number {
  const entries = Object.entries(tools);
  if (entries.length === 0) {
    return 0;
  }

  let total = 0;
  for (const [name, tool] of entries) {
    total += estimateTokens(name);
    if (tool.description) {
      total += estimateTokens(tool.description);
    }
    const schema =
      "inputSchema" in tool
        ? (tool as { inputSchema: unknown }).inputSchema
        : undefined;
    if (schema !== undefined) {
      let schemaJson: string | undefined;
      try {
        schemaJson = JSON.stringify(schema);
      } catch {
        schemaJson = undefined;
      }
      if (schemaJson !== undefined) {
        total += estimateTokens(schemaJson);
      }
    }
  }
  return total;
}
