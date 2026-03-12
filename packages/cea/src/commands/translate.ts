import type { Command } from "@ai-sdk-tool/harness";
import { agentManager } from "../agent";
import { createToggleCommand } from "./factories/create-toggle-command";

export const createTranslateCommand = (): Command =>
  createToggleCommand({
    name: "translate",
    description: "Toggle auto-translation of non-English prompts",
    getter: () => agentManager.isTranslationEnabled(),
    setter: (value) => agentManager.setTranslationEnabled(value),
    featureName: "Translation",
    enabledMessage: "Translation enabled",
    disabledMessage: "Translation disabled",
  });
