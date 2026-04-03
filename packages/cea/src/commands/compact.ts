import type { Command, CommandResult } from "@ai-sdk-tool/harness";

const compactAction = (): CommandResult => ({
  success: true,
  action: { type: "compact" },
  message: "Compaction triggered.",
});

export const createCompactCommand = (): Command => ({
  name: "compact",
  description: "Manually compact conversation history",
  aliases: ["summarize"],
  execute: async (): Promise<CommandResult> => compactAction(),
});
