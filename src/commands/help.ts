import type { Command, CommandResult } from "./types";

export const createHelpCommand = (
  getCommands: () => Map<string, Command>
): Command => ({
  name: "help",
  description: "Show available commands",
  execute: (): CommandResult => {
    const commandList = Array.from(getCommands().values())
      .map((cmd) => `  /${cmd.name} - ${cmd.description}`)
      .join("\n");

    return {
      success: true,
      message: `Available commands:\n${commandList}`,
    };
  },
});
