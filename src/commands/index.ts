import { createHelpCommand } from "./help";
import type { Command, CommandContext, CommandResult } from "./types";

const commands = new Map<string, Command>();

const getCommands = (): Map<string, Command> => commands;

export { getCommands };

export const registerCommand = (command: Command): void => {
  commands.set(command.name, command);
};

registerCommand(createHelpCommand(getCommands));

const COMMAND_PREFIX = "/";
const WHITESPACE_REGEX = /\s+/;

export const isCommand = (input: string): boolean =>
  input.startsWith(COMMAND_PREFIX);

export const parseCommand = (
  input: string
): { name: string; args: string[] } | null => {
  if (!isCommand(input)) {
    return null;
  }

  const parts = input.slice(COMMAND_PREFIX.length).split(WHITESPACE_REGEX);
  const name = parts[0]?.toLowerCase();

  if (!name) {
    return null;
  }

  return { name, args: parts.slice(1) };
};

export const executeCommand = async (
  input: string
): Promise<CommandResult | null> => {
  const parsed = parseCommand(input);

  if (!parsed) {
    return null;
  }

  const command = commands.get(parsed.name);

  if (!command) {
    return {
      success: false,
      message: `Unknown command: /${parsed.name}. Type /help for available commands.`,
    };
  }

  const context: CommandContext = { args: parsed.args };

  return await command.execute(context);
};
