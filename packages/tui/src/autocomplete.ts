import {
  type Command,
  getCommands,
  resolveRegisteredCommandName,
  type SkillInfo,
  toPromptsCommandName,
} from "@ai-sdk-tool/harness";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
  type SlashCommand,
} from "@mariozechner/pi-tui";

const SKILL_LABEL_MAX_WIDTH = 24;

type SlashAutocompleteEntry = SlashCommand | AutocompleteItem;

const truncateAutocompleteLabel = (value: string, maxWidth: number): string => {
  if (value.length <= maxWidth) {
    return value;
  }

  if (maxWidth <= 1) {
    return "…";
  }

  return `${value.slice(0, maxWidth - 1)}…`;
};

const toAutocompleteEntryValue = (entry: SlashAutocompleteEntry): string =>
  "name" in entry ? entry.name : entry.value;

const toAutocompleteItem = (suggestion: SlashCommand): AutocompleteItem => ({
  value: suggestion.name,
  label: suggestion.name,
  ...(suggestion.description ? { description: suggestion.description } : {}),
});

export const createAutocompleteCommands = (
  skills: SkillInfo[],
  commands: Iterable<Command> = getCommands().values()
): SlashAutocompleteEntry[] => {
  const createCommandSuggestion = (
    command: {
      argumentSuggestions?: string[];
      description: string;
      name: string;
    },
    name: string,
    description: string
  ): SlashCommand => {
    const suggestions = command.argumentSuggestions;

    return {
      name,
      description,
      getArgumentCompletions:
        suggestions && suggestions.length > 0
          ? (argumentPrefix: string) => {
              const matches = suggestions.filter((suggestion) =>
                suggestion
                  .toLowerCase()
                  .startsWith(argumentPrefix.toLowerCase())
              );

              if (matches.length === 0) {
                return null;
              }

              return matches.map((match) => ({
                value: match,
                label: match,
              }));
            }
          : undefined,
    } satisfies SlashCommand;
  };

  const commandSuggestions = Array.from(commands).map((command) => {
    const aliases = command.aliases ?? [];
    const aliasSuffix =
      aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";

    return createCommandSuggestion(
      command,
      command.name,
      `${command.description}${aliasSuffix}`
    );
  });

  const skillSuggestions: AutocompleteItem[] = skills.map((skill) => {
    const commandName = toPromptsCommandName(skill.id);
    return {
      value: commandName,
      label: truncateAutocompleteLabel(commandName, SKILL_LABEL_MAX_WIDTH),
      description: skill.description,
    };
  });

  const suggestions: SlashAutocompleteEntry[] = [
    ...commandSuggestions,
    ...skillSuggestions,
  ];
  const seenNames = new Set<string>();
  const uniqueSuggestions: SlashAutocompleteEntry[] = [];

  for (const suggestion of suggestions) {
    const normalizedName = toAutocompleteEntryValue(suggestion).toLowerCase();
    if (seenNames.has(normalizedName)) {
      continue;
    }

    seenNames.add(normalizedName);
    uniqueSuggestions.push(suggestion);
  }

  return uniqueSuggestions;
};

export const buildCommandSuggestionsByName = (
  slashCommands: SlashAutocompleteEntry[]
): Map<string, SlashCommand> => {
  const commandSuggestionsByName = new Map<string, SlashCommand>();

  for (const suggestion of slashCommands) {
    if (!("name" in suggestion)) {
      continue;
    }

    commandSuggestionsByName.set(suggestion.name.toLowerCase(), suggestion);
  }

  return commandSuggestionsByName;
};

export const buildAliasToCanonicalNameMap = (
  commands: Iterable<Command> = getCommands().values()
): Map<string, string> => {
  const aliasToCanonicalName = new Map<string, string>();

  for (const command of commands) {
    const canonicalName = command.name.toLowerCase();

    for (const alias of command.aliases ?? []) {
      const normalizedAlias = alias.toLowerCase();
      if (normalizedAlias === canonicalName) {
        continue;
      }

      aliasToCanonicalName.set(normalizedAlias, canonicalName);
    }
  }

  return aliasToCanonicalName;
};

export const getAliasArgumentSuggestions = async (
  textBeforeCursor: string,
  commandSuggestionsByName: Map<string, SlashCommand>
): Promise<{ items: AutocompleteItem[]; prefix: string } | null> => {
  const spaceIndex = textBeforeCursor.indexOf(" ");
  if (spaceIndex < 0) {
    return null;
  }

  const commandName = textBeforeCursor.slice(1, spaceIndex).toLowerCase();
  const resolvedName = resolveRegisteredCommandName(commandName);
  if (resolvedName === commandName) {
    return null;
  }

  const command = commandSuggestionsByName.get(resolvedName);
  if (!command?.getArgumentCompletions) {
    return null;
  }

  const argumentPrefix = textBeforeCursor.slice(spaceIndex + 1);
  const items = await command.getArgumentCompletions(argumentPrefix);
  if (!items || items.length === 0) {
    return null;
  }

  return {
    items,
    prefix: argumentPrefix,
  };
};

export const getAliasMatches = (
  query: string,
  aliasToCanonicalName: Map<string, string>,
  commandSuggestionsByName: Map<string, SlashCommand>
): AutocompleteItem[] => {
  const aliasMatches: AutocompleteItem[] = [];
  const seenCanonicalNames = new Set<string>();

  for (const [alias, canonicalName] of aliasToCanonicalName) {
    if (!alias.startsWith(query) || seenCanonicalNames.has(canonicalName)) {
      continue;
    }

    const suggestion = commandSuggestionsByName.get(canonicalName);
    if (!suggestion) {
      continue;
    }

    seenCanonicalNames.add(canonicalName);
    aliasMatches.push(toAutocompleteItem(suggestion));
  }

  return aliasMatches;
};

export const mergeAutocompleteItems = (
  prioritizedItems: AutocompleteItem[],
  fallbackItems: AutocompleteItem[] = []
): AutocompleteItem[] => {
  const mergedItems: AutocompleteItem[] = [];
  const seenValues = new Set<string>();

  for (const item of [...prioritizedItems, ...fallbackItems]) {
    const normalizedValue = item.value.toLowerCase();
    if (seenValues.has(normalizedValue)) {
      continue;
    }

    seenValues.add(normalizedValue);
    mergedItems.push(item);
  }

  return mergedItems;
};

export const createAliasAwareAutocompleteProvider = (
  skills: SkillInfo[],
  options?: {
    basePath?: string;
    commands?: Iterable<Command>;
  }
): AutocompleteProvider => {
  const commands = [...(options?.commands ?? getCommands().values())];
  const slashCommands = createAutocompleteCommands(skills, commands);
  const fallbackProvider = new CombinedAutocompleteProvider(
    slashCommands,
    options?.basePath ?? process.cwd()
  );
  const commandSuggestionsByName = buildCommandSuggestionsByName(slashCommands);
  const aliasToCanonicalName = buildAliasToCanonicalNameMap(commands);

  return {
    getSuggestions: async (
      lines,
      cursorLine,
      cursorCol,
      options
    ): Promise<AutocompleteSuggestions | null> => {
      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);

      if (!textBeforeCursor.startsWith("/")) {
        return fallbackProvider.getSuggestions(
          lines,
          cursorLine,
          cursorCol,
          options
        );
      }

      const aliasArgumentSuggestions = await getAliasArgumentSuggestions(
        textBeforeCursor,
        commandSuggestionsByName
      );
      if (aliasArgumentSuggestions) {
        return aliasArgumentSuggestions;
      }

      const defaultSuggestions = await fallbackProvider.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        options
      );

      if (textBeforeCursor.includes(" ")) {
        return defaultSuggestions;
      }

      const query = textBeforeCursor.slice(1).toLowerCase();
      if (query.length === 0) {
        return defaultSuggestions;
      }

      const aliasMatches = getAliasMatches(
        query,
        aliasToCanonicalName,
        commandSuggestionsByName
      );

      if (aliasMatches.length === 0) {
        return defaultSuggestions;
      }

      return {
        items: mergeAutocompleteItems(aliasMatches, defaultSuggestions?.items),
        prefix: textBeforeCursor,
      };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      fallbackProvider.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix
      ),
  };
};
