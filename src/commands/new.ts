import type { Command, CommandResult } from "./types";

const newSessionAction = (): CommandResult => ({
  success: true,
  action: "new-session",
});

export const createNewCommand = (): Command => ({
  name: "new",
  description: "Start a new session",
  execute: () => newSessionAction(),
});
