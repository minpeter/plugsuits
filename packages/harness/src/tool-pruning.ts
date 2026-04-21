import type { CheckpointMessage, PruningConfig } from "./compaction-types";
import { estimateTokens, extractMessageText } from "./token-utils";

// ─── Configuration ───

const DEFAULT_REPLACEMENT_TEXT = "[output pruned — too large]";
const DEFAULT_PROTECT_RECENT_TOKENS = 2000;
const DEFAULT_MIN_SAVINGS_TOKENS = 200;
const PROGRESSIVE_LEVELS = [0, 10, 20, 50, 100] as const;
const DEFAULT_PROGRESSIVE_REPLACEMENT_TEXT = "[output pruned]";
const DEFAULT_PROGRESSIVE_PROTECT_RECENT_TOKENS = 40_000;

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

export type { PruningConfig } from "./compaction-types";

const DEFAULT_EAGER_PRUNE_TOOL_NAMES = [
  "read_file",
  "readFile",
  "grep",
  "grep_files",
  "grepFiles",
  "list_dir",
  "listDir",
  "list_files",
  "listFiles",
] as const;

export function createDefaultPruningConfig(): PruningConfig {
  return {
    eagerPruneToolNames: [...DEFAULT_EAGER_PRUNE_TOOL_NAMES],
  };
}

export function createChatbotPruningConfig(): PruningConfig {
  return {
    minSavingsTokens: 500,
    protectRecentTokens: Number.MAX_SAFE_INTEGER,
    replacementText: "[output pruned — too large]",
  };
}

/**
 * Result of a pruning operation.
 */
export interface PruneResult {
  /** Messages after pruning (same length as input). */
  messages: CheckpointMessage[];
  /** Number of individual tool outputs that were pruned. */
  prunedCount: number;
  /** Total estimated tokens saved by pruning. */
  prunedTokens: number;
}

export interface ProgressivePruneResult {
  levelUsed: number;
  messages: CheckpointMessage[];
  tokensAfter: number;
  tokensBefore: number;
}

interface PrunableToolResultRef {
  messageIndex: number;
  partIndex: number;
  toolName: string;
}

function estimateCheckpointTokens(messages: CheckpointMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total + estimateTokens(extractMessageText(message.message)),
    0
  );
}

function resolveProtectedFromIndex(
  messages: CheckpointMessage[],
  protectRecentTokens: number
): number {
  let protectedFromIndex = messages.length;
  let recentTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(extractMessageText(messages[i].message));
    if (recentTokens + msgTokens > protectRecentTokens) {
      protectedFromIndex = i + 1;
      break;
    }
    recentTokens += msgTokens;
    if (i === 0) {
      protectedFromIndex = 0;
    }
  }

  return protectedFromIndex;
}

function collectPrunableToolResultRefs(
  messages: CheckpointMessage[],
  protectedFromIndex: number,
  protectedToolNames: Set<string>,
  eagerPruneToolNames: Set<string>
): PrunableToolResultRef[] {
  const refs: PrunableToolResultRef[] = [];
  const eagerRefsByTool = new Map<string, PrunableToolResultRef[]>();

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const modelMessage = messages[messageIndex].message;
    if (modelMessage.role !== "tool" || !Array.isArray(modelMessage.content)) {
      continue;
    }

    for (
      let partIndex = 0;
      partIndex < modelMessage.content.length;
      partIndex++
    ) {
      const part = modelMessage.content[partIndex];
      if (!isToolResultPart(part)) {
        continue;
      }
      if (protectedToolNames.has(part.toolName)) {
        continue;
      }

      const ref = { messageIndex, partIndex, toolName: part.toolName };
      if (messageIndex < protectedFromIndex) {
        refs.push(ref);
        continue;
      }

      if (eagerPruneToolNames.has(part.toolName)) {
        const toolRefs = eagerRefsByTool.get(part.toolName) ?? [];
        toolRefs.push(ref);
        eagerRefsByTool.set(part.toolName, toolRefs);
      }
    }
  }

  for (const toolRefs of eagerRefsByTool.values()) {
    refs.push(...toolRefs.slice(0, Math.max(0, toolRefs.length - 2)));
  }

  return refs;
}

function applyProgressivePruningLevel(
  messages: CheckpointMessage[],
  prunableRefs: PrunableToolResultRef[],
  removeCount: number,
  replacementText: string
): CheckpointMessage[] {
  if (removeCount <= 0 || prunableRefs.length === 0) {
    return messages;
  }

  const boundedRemoveCount = Math.min(removeCount, prunableRefs.length);
  const start = Math.floor((prunableRefs.length - boundedRemoveCount) / 2);
  const compactedAt = Date.now();

  const replacementsByMessage = new Map<number, unknown[]>();

  for (let offset = 0; offset < boundedRemoveCount; offset++) {
    const ref = prunableRefs[start + offset];
    const originalMessage = messages[ref.messageIndex];
    const originalContent = originalMessage.message.content;
    if (!Array.isArray(originalContent)) {
      continue;
    }

    const mutableContent = replacementsByMessage.get(ref.messageIndex) ?? [
      ...originalContent,
    ];
    const part = mutableContent[ref.partIndex];

    if (isToolResultPart(part)) {
      mutableContent[ref.partIndex] = {
        ...part,
        compactedAt,
        output: { type: "text" as const, value: replacementText },
      };
      replacementsByMessage.set(ref.messageIndex, mutableContent);
    }
  }

  if (replacementsByMessage.size === 0) {
    return messages;
  }

  return messages.map((checkpoint, index) => {
    const content = replacementsByMessage.get(index);
    if (!content) {
      return checkpoint;
    }

    return {
      ...checkpoint,
      message: {
        ...checkpoint.message,
        content: content as never,
      },
    };
  });
}

export function progressivePrune(
  messages: CheckpointMessage[],
  config: PruningConfig & { targetTokens: number }
): ProgressivePruneResult {
  const tokensBefore = estimateCheckpointTokens(messages);
  const protectRecentTokens =
    config.protectRecentTokens ?? DEFAULT_PROGRESSIVE_PROTECT_RECENT_TOKENS;
  const protectedToolNames = new Set(config.protectedToolNames ?? []);
  const eagerPruneToolNames = new Set(config.eagerPruneToolNames ?? []);
  const replacementText =
    config.replacementText ?? DEFAULT_PROGRESSIVE_REPLACEMENT_TEXT;

  const protectedFromIndex = resolveProtectedFromIndex(
    messages,
    protectRecentTokens
  );
  const prunableRefs = collectPrunableToolResultRefs(
    messages,
    protectedFromIndex,
    protectedToolNames,
    eagerPruneToolNames
  );

  let level4Result: ProgressivePruneResult | null = null;

  for (
    let levelIndex = 0;
    levelIndex < PROGRESSIVE_LEVELS.length;
    levelIndex++
  ) {
    const percentage = PROGRESSIVE_LEVELS[levelIndex];
    const removeCount = Math.floor((prunableRefs.length * percentage) / 100);
    const candidateMessages = applyProgressivePruningLevel(
      messages,
      prunableRefs,
      removeCount,
      replacementText
    );
    const tokensAfter = estimateCheckpointTokens(candidateMessages);
    const result: ProgressivePruneResult = {
      levelUsed: levelIndex,
      messages: candidateMessages,
      tokensAfter,
      tokensBefore,
    };

    if (tokensAfter <= config.targetTokens) {
      return result;
    }

    if (levelIndex === PROGRESSIVE_LEVELS.length - 1) {
      level4Result = result;
    }
  }

  return (
    level4Result ?? {
      levelUsed: PROGRESSIVE_LEVELS.length - 1,
      messages,
      tokensAfter: tokensBefore,
      tokensBefore,
    }
  );
}

/**
 * Prune large tool outputs from messages to reduce token usage.
 *
 * Walks through messages from oldest to newest. Messages within the
 * `protectRecentTokens` window (counted from the end) are never pruned.
 * For older messages with `tool-result` parts, large outputs are replaced
 * with a short stub.
 *
 * @param messages - Active checkpoint-message slice to prune (not mutated)
 * @param config - Pruning configuration
 * @returns Pruned messages array and statistics
 */
export function pruneToolOutputs(
  messages: CheckpointMessage[],
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
  const compactedAt = Date.now();

  // Calculate the protection boundary: walk backwards to find which messages
  // fall within the protectRecentTokens window
  let protectedFromIndex = messages.length;
  let recentTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(extractMessageText(messages[i].message));
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
  const result: CheckpointMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const modelMessage = msg.message;

    // Protected window — keep as-is
    if (i >= protectedFromIndex) {
      result.push(msg);
      continue;
    }

    // Only prune "tool" role messages (which contain tool-result parts)
    if (modelMessage.role !== "tool" || !Array.isArray(modelMessage.content)) {
      result.push(msg);
      continue;
    }

    let messagePruned = false;
    const newContent = modelMessage.content.map((part) => {
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
        compactedAt,
        output: { type: "text" as const, value: replacementText },
      };
    });

    if (messagePruned) {
      result.push({
        ...msg,
        message: {
          ...modelMessage,
          content: newContent,
        },
      });
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
