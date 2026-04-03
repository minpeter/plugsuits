import type { CheckpointMessage } from "./compaction-types";

interface ToolCallLikePart {
  toolCallId: string;
  type: "tool-call";
}

interface ToolResultLikePart {
  toolCallId: string;
  type: "tool-result";
}

function isToolCallLikePart(part: unknown): part is ToolCallLikePart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "tool-call" &&
    "toolCallId" in part &&
    typeof part.toolCallId === "string"
  );
}

function isToolResultLikePart(part: unknown): part is ToolResultLikePart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "tool-result" &&
    "toolCallId" in part &&
    typeof part.toolCallId === "string"
  );
}

function getToolCallIds(message: CheckpointMessage): string[] {
  const modelMessage = message.message;
  if (
    modelMessage.role !== "assistant" ||
    !Array.isArray(modelMessage.content)
  ) {
    return [];
  }

  return modelMessage.content.flatMap((part) => {
    if (isToolCallLikePart(part)) {
      return [part.toolCallId];
    }

    return [];
  });
}

function getToolResultIds(message: CheckpointMessage): string[] {
  const modelMessage = message.message;
  if (
    (modelMessage.role !== "user" && modelMessage.role !== "tool") ||
    !Array.isArray(modelMessage.content)
  ) {
    return [];
  }

  return modelMessage.content.flatMap((part) => {
    if (isToolResultLikePart(part)) {
      return [part.toolCallId];
    }

    return [];
  });
}

function collectToolResultIdsFromRange(
  messages: CheckpointMessage[],
  fromIndex: number
): Set<string> {
  const toolResultIds = new Set<string>();

  for (let i = fromIndex; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }

    for (const toolResultId of getToolResultIds(message)) {
      toolResultIds.add(toolResultId);
    }
  }

  return toolResultIds;
}

function collectToolCallIdsFromRange(
  messages: CheckpointMessage[],
  fromIndex: number
): Set<string> {
  const toolCallIds = new Set<string>();

  for (let i = fromIndex; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }

    for (const toolCallId of getToolCallIds(message)) {
      toolCallIds.add(toolCallId);
    }
  }

  return toolCallIds;
}

function collectUnresolvedToolCallIds(
  messages: CheckpointMessage[],
  splitIndex: number
): Set<string> {
  const unresolvedToolCallIds = collectToolResultIdsFromRange(
    messages,
    splitIndex
  );
  if (unresolvedToolCallIds.size === 0) {
    return unresolvedToolCallIds;
  }

  const toolCallIdsInKeptRange = collectToolCallIdsFromRange(
    messages,
    splitIndex
  );
  for (const toolCallId of toolCallIdsInKeptRange) {
    unresolvedToolCallIds.delete(toolCallId);
  }

  return unresolvedToolCallIds;
}

function findEarliestToolCallIndexBeforeSplit(
  messages: CheckpointMessage[],
  splitIndex: number,
  unresolvedToolCallIds: Set<string>
): number {
  let nextIndex = splitIndex;

  for (
    let i = splitIndex - 1;
    i >= 0 && unresolvedToolCallIds.size > 0;
    i -= 1
  ) {
    const message = messages[i];
    if (!message) {
      continue;
    }

    const matchingIds = getToolCallIds(message).filter((toolCallId) =>
      unresolvedToolCallIds.has(toolCallId)
    );

    if (matchingIds.length === 0) {
      continue;
    }

    nextIndex = i;
    for (const toolCallId of matchingIds) {
      unresolvedToolCallIds.delete(toolCallId);
    }
  }

  return nextIndex;
}

export function adjustSplitIndexForToolPairs(
  messages: CheckpointMessage[],
  proposedIndex: number
): number {
  if (proposedIndex <= 0 || proposedIndex >= messages.length) {
    return proposedIndex;
  }

  let adjustedIndex = proposedIndex;

  while (adjustedIndex > 0) {
    const unresolvedToolCallIds = collectUnresolvedToolCallIds(
      messages,
      adjustedIndex
    );
    if (unresolvedToolCallIds.size === 0) {
      return adjustedIndex;
    }

    const nextIndex = findEarliestToolCallIndexBeforeSplit(
      messages,
      adjustedIndex,
      unresolvedToolCallIds
    );

    if (nextIndex === adjustedIndex) {
      return adjustedIndex;
    }

    adjustedIndex = nextIndex;
  }

  return adjustedIndex;
}
