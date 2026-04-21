import type { PreferencesStore } from "@ai-sdk-tool/harness";
import type { AgentManager } from "../agent";
import type { SharedConfig } from "../cli-defs";
import type { UserPreferences } from "../user-preferences";

export const applyPersistedPreferencesToAgentManager = async (
  agent: AgentManager,
  store: PreferencesStore<UserPreferences>,
  onLoadError: (error: unknown) => void = (error) =>
    console.error("[preferences] Failed to load user preferences:", error)
): Promise<void> => {
  const storedPreferences = await store.load().catch((error) => {
    onLoadError(error);
    return null;
  });
  if (storedPreferences?.translateEnabled !== undefined) {
    agent.setTranslationEnabled(storedPreferences.translateEnabled);
  }
  if (storedPreferences?.reasoningMode !== undefined) {
    agent.setReasoningMode(storedPreferences.reasoningMode);
  }
  if (storedPreferences?.toolFallbackMode !== undefined) {
    agent.setToolFallbackMode(storedPreferences.toolFallbackMode);
  }
};

export const applySharedConfigToAgentManager = (
  agent: AgentManager,
  config: SharedConfig
): void => {
  if (config.model) {
    agent.setModelId(config.model);
  }
  if (config.reasoningMode !== null) {
    agent.setReasoningMode(config.reasoningMode);
  }
  if (config.toolFallbackModeExplicit && config.toolFallbackMode !== null) {
    agent.setToolFallbackMode(config.toolFallbackMode);
  }
  if (config.translateUserPrompts !== null) {
    agent.setTranslationEnabled(config.translateUserPrompts);
  }
};
