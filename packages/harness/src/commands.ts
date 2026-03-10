export interface CommandContext {
  args: string[];
}

export interface CommandAction {
  type: "new-session";
}

export interface CommandResult {
  action?: CommandAction;
  message?: string;
  success: boolean;
}

export interface Command {
  aliases?: string[];
  argumentSuggestions?: string[];
  description: string;
  displayName?: string;
  execute: (context: CommandContext) => CommandResult | Promise<CommandResult>;
  name: string;
}

export interface SkillCommandResult extends CommandResult {
  isSkill: true;
  skillContent: string;
  skillId: string;
}

export interface CommandRegistryConfig {
  skillLoader?: (
    name: string
  ) => Promise<{ content: string; id: string } | null>;
}

const commands = new Map<string, Command>();
const commandAliases = new Map<string, string>();
const COMMAND_PREFIX = "/";
const WHITESPACE_REGEX = /\s+/;

let registryConfig: CommandRegistryConfig = {};

export const configureCommandRegistry = (
  config: CommandRegistryConfig
): void => {
  registryConfig = config;
};

const getCommandName = (command: Command): string => {
  if (command.displayName) {
    return command.displayName;
  }

  if (command.aliases && command.aliases.length > 0) {
    return `${command.name} (${command.aliases.join(", ")})`;
  }

  return command.name;
};

export const getCommands = (): Map<string, Command> => commands;

export const createHelpCommand = (
  getRegisteredCommands: () => Map<string, Command>
): Command => ({
  name: "help",
  description: "Show available commands",
  execute: (): CommandResult => {
    const commandList = Array.from(getRegisteredCommands().values())
      .map(
        (command) => `  /${getCommandName(command)} - ${command.description}`
      )
      .join("\n");

    return {
      success: true,
      message: `Available commands:\n${commandList}`,
    };
  },
});

export const registerCommand = (command: Command): void => {
  const normalizedName = command.name.toLowerCase();

  if (commands.has(normalizedName)) {
    throw new Error(`Duplicate command name: ${normalizedName}`);
  }

  const existingAliasTarget = commandAliases.get(normalizedName);
  if (existingAliasTarget) {
    throw new Error(
      `Command name '${normalizedName}' conflicts with existing alias for /${existingAliasTarget}`
    );
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
    const skill = await registryConfig.skillLoader?.(parsed.name);
    if (skill) {
      return {
        success: true,
        isSkill: true,
        skillId: skill.id,
        skillContent: skill.content,
      };
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
