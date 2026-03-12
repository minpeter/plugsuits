export function calculateAggressiveCompactionSplitIndex(
  messageCount: number
): number | null {
  return messageCount > 1 ? messageCount : null;
}

export function calculateDefaultCompactionSplitIndex<T>(params: {
  adjustSplitIndex: (splitIndex: number) => number;
  estimateMessageTokens: (message: T) => number;
  keepRecentTokens: number;
  messages: T[];
}): number | null {
  const {
    adjustSplitIndex,
    estimateMessageTokens,
    keepRecentTokens,
    messages,
  } = params;

  let keptTokens = 0;
  let splitIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }

    const msgTokens = estimateMessageTokens(message);
    if (keptTokens + msgTokens > keepRecentTokens) {
      splitIndex = i + 1;
      break;
    }

    keptTokens += msgTokens;
    if (i === 0) {
      splitIndex = 0;
    }
  }

  if (splitIndex === 0) {
    if (messages.length <= 1) {
      return null;
    }
    splitIndex = Math.max(1, Math.floor(messages.length / 2));
  }

  if (splitIndex >= messages.length) {
    return null;
  }

  splitIndex = adjustSplitIndex(splitIndex);
  if (splitIndex >= messages.length || splitIndex <= 0) {
    return null;
  }

  return splitIndex;
}

export function calculateCompactionSplitIndex<T>(params: {
  adjustSplitIndex: (splitIndex: number) => number;
  aggressive: boolean;
  estimateMessageTokens: (message: T) => number;
  keepRecentTokens: number;
  messages: T[];
}): number | null {
  if (params.aggressive) {
    return calculateAggressiveCompactionSplitIndex(params.messages.length);
  }

  return calculateDefaultCompactionSplitIndex(params);
}
