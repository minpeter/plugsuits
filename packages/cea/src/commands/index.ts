import { configureCommandRegistry } from "@ai-sdk-tool/harness";
import { toPromptsCommandName } from "../context/skill-command-prefix";
import { loadSkillById } from "../context/skills";

interface SkillLoadEvent {
  content: string;
  id: string;
  name: string;
}

type SkillLoadListener = (event: SkillLoadEvent) => void;

const skillLoadListeners = new Set<SkillLoadListener>();

const notifySkillLoaded = (event: SkillLoadEvent): void => {
  for (const listener of skillLoadListeners) {
    listener(event);
  }
};

export const registerSkillLoadListener = (
  listener: SkillLoadListener
): (() => void) => {
  skillLoadListeners.add(listener);
  return () => {
    skillLoadListeners.delete(listener);
  };
};

configureCommandRegistry({
  skillLoader: async (name: string) => {
    const skill = await loadSkillById(name);
    if (!skill) {
      return null;
    }

    notifySkillLoaded({
      content: skill.content,
      id: skill.info.id,
      name: skill.info.name,
    });

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
