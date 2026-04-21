import type { Command, LayeredPreferences } from "@ai-sdk-tool/harness";
import { createTogglePreferenceCommand } from "@ai-sdk-tool/harness/preferences";
import { agentManager } from "../agent";
import type { UserPreferences } from "../user-preferences";
import { getPreferencesBundle } from "./preferences-persistence";

export const createTranslateCommand = (
  bundle: LayeredPreferences<UserPreferences> | null = getPreferencesBundle()
): Command => {
  if (!bundle) {
    throw new Error(
      "createTranslateCommand: preferences bundle is not configured. Call configurePreferencesPersistence({ bundle, workspaceStore }) first."
    );
  }
  return createTogglePreferenceCommand<UserPreferences, "translateEnabled">({
    name: "translate",
    description: "Toggle auto-translation of non-English prompts",
    featureName: "Translation",
    preferences: bundle,
    field: "translateEnabled",
    get: () => agentManager.isTranslationEnabled(),
    set: (next) => {
      agentManager.setTranslationEnabled(next);
    },
    enabledMessage: "Translation enabled",
    disabledMessage: "Translation disabled",
  });
};
