import type {
  Command,
  CommandResult,
  MessageHistory,
} from "@ai-sdk-tool/harness";

export const createCompactCommand = (
  getMessageHistory: () => MessageHistory
): Command => ({
  name: "compact",
  description: "Force conversation compaction",
  execute: async (): Promise<CommandResult> => {
    const history = getMessageHistory();

    if (!history.isCompactionEnabled()) {
      return {
        success: false,
        message: "Compaction is not enabled for the current configuration.",
      };
    }

    const messageCount = history.getAll().length;
    if (messageCount < 2) {
      return {
        success: true,
        message: "Nothing to compact (need at least 2 messages).",
      };
    }

    const tokensBefore = history.getEstimatedTokens();
    const summaryIdBefore = history.getSummaries()[0]?.id ?? null;

    const compacted = await history.compact();

    if (!compacted) {
      return {
        success: true,
        message: `Nothing to compact (${tokensBefore.toLocaleString()} tokens, ${messageCount} messages).`,
      };
    }

    const summaryIdAfter = history.getSummaries()[0]?.id ?? null;
    const actuallyCompacted = summaryIdAfter !== summaryIdBefore;

    const tokensAfter = history.getEstimatedTokens();
    const messagesAfter = history.getAll().length;
    const reduction =
      tokensBefore > 0
        ? Math.max(0, Math.round((1 - tokensAfter / tokensBefore) * 100))
        : 0;

    if (actuallyCompacted) {
      return {
        success: true,
        message: `✓ Compacted: ${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens (${reduction}% reduction, ${messageCount} → ${messagesAfter} messages)`,
      };
    }

    // Pruning-only: compact() returned true but no new summary was created
    return {
      success: true,
      message: `✓ Pruned: ${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens (${reduction}% reduction, ${messageCount} → ${messagesAfter} messages)`,
    };
  },
});
