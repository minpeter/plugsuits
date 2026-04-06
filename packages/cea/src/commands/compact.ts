import type {
  CheckpointHistory,
  Command,
  CommandResult,
} from "@ai-sdk-tool/harness";

interface CompactCommandOptions {
  messageHistory: CheckpointHistory;
}

export const createCompactCommand = (
  options: CompactCommandOptions
): Command => ({
  name: "compact",
  description: "Manually compact conversation history",
  aliases: ["summarize"],
  execute: async (): Promise<CommandResult> => {
    try {
      await options.messageHistory.compact();
      return { success: true, message: "Compaction completed." };
    } catch (error) {
      return {
        success: false,
        message: `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
