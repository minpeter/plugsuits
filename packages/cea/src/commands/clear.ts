import type { Command, CommandResult } from "@ai-sdk-tool/harness";

const newSessionAction = (): CommandResult => ({
  success: true,
  action: "new-session",
});

export const createClearCommand = (): Command => ({
  name: "clear",
  displayName: "clear (new)",
  aliases: ["new"],
  description: "Start a new session",
  execute: () => newSessionAction(),
});
