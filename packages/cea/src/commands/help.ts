import type { Command, CommandResult } from "./types";

export const createHelpCommand = (
  getCommands: () => Map<string, Command>
): Command => ({
  name: "help",
  description: "Show available commands",
  execute: (): CommandResult => {
    const getCommandName = (command: Command): string => {
      if (command.displayName) {
        return command.displayName;
      }

      if (command.aliases && command.aliases.length > 0) {
        return `${command.name} (${command.aliases.join(", ")})`;
      }

      return command.name;
    };

    const commandList = Array.from(getCommands().values())
      .map((cmd) => `  /${getCommandName(cmd)} - ${cmd.description}`)
      .join("\n");

    return {
      success: true,
      message: `Available commands:\n${commandList}`,
    };
  },
});
