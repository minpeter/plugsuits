export const PROMPTS_COMMAND_PREFIX = "prompts:";

export const toPromptsCommandName = (skillId: string): string => {
  if (skillId.startsWith(PROMPTS_COMMAND_PREFIX)) {
    return skillId;
  }

  return `${PROMPTS_COMMAND_PREFIX}${skillId}`;
};

export const parsePromptsCommandName = (commandName: string): string | null => {
  if (!commandName.startsWith(PROMPTS_COMMAND_PREFIX)) {
    return null;
  }

  const skillId = commandName.slice(PROMPTS_COMMAND_PREFIX.length);
  return skillId.length > 0 ? skillId : null;
};
