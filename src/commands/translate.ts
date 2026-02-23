import { agentManager } from "../agent";
import { createToggleCommand } from "./factories/create-toggle-command";
import type { Command } from "./types";

export const createTranslateCommand = (): Command =>
  createToggleCommand({
    name: "translate",
    description: "Toggle auto-translation of non-English prompts",
    getter: () => agentManager.isUserInputTranslationEnabled(),
    setter: (value) => agentManager.setUserInputTranslationEnabled(value),
    featureName: "Prompt translation",
    enabledMessage: "Prompt translation enabled",
    disabledMessage: "Prompt translation disabled",
  });
