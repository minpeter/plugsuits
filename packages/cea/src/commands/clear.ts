import type { Command, CommandResult } from "./types";

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
