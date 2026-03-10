import type { ModelMessage, TextPart } from "ai";
import { estimateTokens } from "./message-history";

function extractMessageText(message: ModelMessage): string {
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

// ─── Configuration ───

const DEFAULT_REPLACEMENT_TEXT = "[output pruned — too large]";
const DEFAULT_PROTECT_RECENT_TOKENS = 2000;
const DEFAULT_MIN_SAVINGS_TOKENS = 200;

function isToolResultPart(part: unknown): part is {
  output: unknown;
  toolName: string;
  type: "tool-result";
} {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "tool-result" &&
    "toolName" in part &&
    "output" in part
  );
}

/**
 * Configuration for tool output pruning.
 */
export interface PruningConfig {
  /**
   * Enable tool output pruning.
   * @default false
   */
  enabled?: boolean;

  /**
   * Minimum estimated token savings required for pruning to take effect.
   * If total savings are below this threshold, no pruning occurs.
   * @default 200
   */
  minSavingsTokens?: number;

  /**
   * Tool names whose outputs should never be pruned.
   * Useful for critical tools whose output must always be preserved in full.
   */
  protectedToolNames?: string[];

  /**
   * Number of recent tokens (from the end of conversation) to protect from pruning.
   * Messages within this window are never pruned.
   * @default 2000
   */
  protectRecentTokens?: number;

  /**
   * Text to replace pruned tool outputs with.
   * @default "[output pruned — too large]"
   */
  replacementText?: string;
}

/**
 * Result of a pruning operation.
 */
export interface PruneResult {
  /** Messages after pruning (same length as input). */
  messages: ModelMessage[];
  /** Number of individual tool outputs that were pruned. */
  prunedCount: number;
  /** Total estimated tokens saved by pruning. */
  prunedTokens: number;
}

/**
 * Prune large tool outputs from messages to reduce token usage.
 *
 * Walks through messages from oldest to newest. Messages within the
 * `protectRecentTokens` window (counted from the end) are never pruned.
 * For older messages with `tool-result` parts, large outputs are replaced
 * with a short stub.
 *
 * @param messages - Array of model messages (not mutated)
 * @param config - Pruning configuration
 * @returns Pruned messages array and statistics
 */
export function pruneToolOutputs(
  messages: ModelMessage[],
  config: PruningConfig
): PruneResult {
  if (messages.length === 0) {
    return { messages: [], prunedTokens: 0, prunedCount: 0 };
  }

  const protectRecentTokens =
    config.protectRecentTokens ?? DEFAULT_PROTECT_RECENT_TOKENS;
  const minSavingsTokens =
    config.minSavingsTokens ?? DEFAULT_MIN_SAVINGS_TOKENS;
  const protectedToolNames = new Set(config.protectedToolNames ?? []);
  const replacementText = config.replacementText ?? DEFAULT_REPLACEMENT_TEXT;
  const replacementTokens = estimateTokens(replacementText);

  // Calculate the protection boundary: walk backwards to find which messages
  // fall within the protectRecentTokens window
  let protectedFromIndex = messages.length;
  let recentTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(extractMessageText(messages[i]));
    if (recentTokens + msgTokens > protectRecentTokens) {
      protectedFromIndex = i + 1;
      break;
    }
    recentTokens += msgTokens;
    if (i === 0) {
      protectedFromIndex = 0;
    }
  }

  // Walk messages and prune tool outputs outside the protected window
  let totalPrunedTokens = 0;
  let prunedCount = 0;
  const result: ModelMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Protected window — keep as-is
    if (i >= protectedFromIndex) {
      result.push(msg);
      continue;
    }

    // Only prune "tool" role messages (which contain tool-result parts)
    if (msg.role !== "tool" || !Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    let messagePruned = false;
    const newContent = msg.content.map((part) => {
      if (!isToolResultPart(part)) {
        return part;
      }

      // Skip protected tool names
      if (protectedToolNames.has(part.toolName)) {
        return part;
      }

      const outputStr =
        typeof part.output === "string"
          ? part.output
          : JSON.stringify(part.output);
      const outputTokens = estimateTokens(outputStr);

      if (outputTokens <= replacementTokens * 2) {
        return part;
      }

      const savedTokens = outputTokens - replacementTokens;
      totalPrunedTokens += savedTokens;
      prunedCount++;
      messagePruned = true;

      return {
        ...part,
        output: { type: "text" as const, value: replacementText },
      };
    });

    if (messagePruned) {
      result.push({ ...msg, content: newContent });
    } else {
      result.push(msg);
    }
  }

  // If total savings are below threshold, return original messages unchanged
  if (totalPrunedTokens < minSavingsTokens) {
    return { messages, prunedTokens: 0, prunedCount: 0 };
  }

  return { messages: result, prunedTokens: totalPrunedTokens, prunedCount };
}
