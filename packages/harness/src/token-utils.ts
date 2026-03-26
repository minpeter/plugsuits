import type { ModelMessage, TextPart } from "ai";

// Constants for token estimation
export const LATIN_CHARS_PER_TOKEN = 4;
export const CJK_CHARS_PER_TOKEN = 1.5;

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

/**
 * Estimate token count for a ModelMessage, with content-type-aware weighting.
 * Tool-call and tool-result parts use chars/3 weighting (heavier than text's chars/4).
 * TODO: implement in T4
 */
export function estimateMessageTokens(_message: ModelMessage): number {
  throw new Error("estimateMessageTokens not implemented yet");
}
