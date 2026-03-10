import {
  type Command,
  createHelpCommand,
  getCommands,
} from "@ai-sdk-tool/harness";

export interface TuiCommandSet {
  commandAliasLookup: Map<string, string>;
  commandLookup: Map<string, Command>;
  commands: Command[];
}

export function buildTuiCommandSet(
  localCommands?: Iterable<Command>
): TuiCommandSet {
  const mergedCommands = new Map<string, Command>();
  const providedCommands = [...(localCommands ?? [])];

  for (const command of getCommands().values()) {
    mergedCommands.set(command.name.toLowerCase(), command);
  }

  for (const command of providedCommands) {
    mergedCommands.set(command.name.toLowerCase(), command);
  }

  const hasCustomHelp = providedCommands.some(
    (command) => command.name.toLowerCase() === "help"
  );
  if (!hasCustomHelp) {
    mergedCommands.set(
      "help",
      createHelpCommand(() => mergedCommands)
    );
  }

  const commandAliasLookup = new Map<string, string>();
  for (const command of mergedCommands.values()) {
    const normalizedName = command.name.toLowerCase();
    for (const alias of command.aliases ?? []) {
      const normalizedAlias = alias.toLowerCase();
      if (normalizedAlias !== normalizedName) {
        commandAliasLookup.set(normalizedAlias, normalizedName);
      }
    }
  }

  return {
    commandAliasLookup,
    commandLookup: mergedCommands,
    commands: [...mergedCommands.values()],
  };
}
