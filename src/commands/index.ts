import { loadAllSkills, loadSkillById } from "../context/skills";
import { createHelpCommand } from "./help";
import type { Command, CommandContext, CommandResult } from "./types";

export interface SkillCommandResult extends CommandResult {
  isSkill: true;
  skillContent: string;
  skillId: string;
}

const commands = new Map<string, Command>();
const commandAliases = new Map<string, string>();

const getCommands = (): Map<string, Command> => commands;

export { getCommands };

export const registerCommand = (command: Command): void => {
  const normalizedName = command.name.toLowerCase();

  if (commands.has(normalizedName)) {
    throw new Error(`Duplicate command name: ${normalizedName}`);
  }

  const aliases = command.aliases?.map((alias) => alias.toLowerCase()) ?? [];
  const normalizedCommand: Command = {
    ...command,
    name: normalizedName,
    aliases,
  };
  commands.set(normalizedName, normalizedCommand);

  for (const alias of aliases) {
    if (alias === normalizedName) {
      continue;
    }

    if (commands.has(alias)) {
      throw new Error(
        `Alias '${alias}' for /${normalizedName} conflicts with command /${alias}`
      );
    }

    const existingTarget = commandAliases.get(alias);
    if (existingTarget && existingTarget !== normalizedName) {
      throw new Error(
        `Alias '${alias}' for /${normalizedName} already maps to /${existingTarget}`
      );
    }

    commandAliases.set(alias, normalizedName);
  }
};

export const resolveRegisteredCommandName = (name: string): string => {
  const normalizedName = name.toLowerCase();
  return commandAliases.get(normalizedName) ?? normalizedName;
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
): Promise<CommandResult | SkillCommandResult | null> => {
  const parsed = parseCommand(input);

  if (!parsed) {
    return null;
  }

  const resolvedName = resolveRegisteredCommandName(parsed.name);
  const command = commands.get(resolvedName);

  if (!command) {
    // Check if it's a skill
    const skill = await loadSkillById(parsed.name);
    if (skill) {
      return {
        success: true,
        isSkill: true,
        skillId: skill.info.id,
        skillContent: skill.content,
      } as SkillCommandResult;
    }

    return {
      success: false,
      message: `Unknown command: /${parsed.name}. Type /help for available commands.`,
    };
  }

  const context: CommandContext = { args: parsed.args };

  return await command.execute(context);
};

export const isSkillCommandResult = (
  result: CommandResult | SkillCommandResult | null
): result is SkillCommandResult => {
  return result !== null && "isSkill" in result && result.isSkill === true;
};

export const getAvailableSkillIds = async (): Promise<string[]> => {
  const skills = await loadAllSkills();
  return skills.map((s) => s.id);
};
