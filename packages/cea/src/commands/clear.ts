import type { Command, CommandResult } from "@ai-sdk-tool/harness";

const newSessionAction = (): CommandResult => ({
  success: true,
  action: { type: "new-session" },
});

export const createClearCommand = (): Command => ({
  name: "new",
  aliases: ["clear"],
  description: "Start a new session",
  execute: () => newSessionAction(),
});
