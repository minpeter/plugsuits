import { configureCommandRegistry } from "@ai-sdk-tool/harness";
import { toPromptsCommandName } from "../context/skill-command-prefix";
import { loadSkillById } from "../context/skills";

configureCommandRegistry({
  skillLoader: async (name: string) => {
    const skill = await loadSkillById(name);
    if (!skill) {
      return null;
    }

    return {
      content: skill.content,
      id: toPromptsCommandName(skill.info.id),
    };
  },
});

export {
  type Command,
  type CommandContext,
  type CommandRegistryConfig,
  type CommandResult,
  configureCommandRegistry,
  createHelpCommand,
  executeCommand,
  getCommands,
  isCommand,
  isSkillCommandResult,
  parseCommand,
  registerCommand,
  resolveRegisteredCommandName,
  type SkillCommandResult,
} from "@ai-sdk-tool/harness";
