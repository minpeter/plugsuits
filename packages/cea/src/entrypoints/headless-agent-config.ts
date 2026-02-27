import type { ProviderType } from "../agent";
import type { ReasoningMode } from "../reasoning-mode";
import type { ToolFallbackMode } from "../tool-fallback-mode";

export interface HeadlessRuntimeOptions {
  model?: string;
  provider: ProviderType | null;
  reasoningMode: ReasoningMode | null;
  toolFallbackMode: ToolFallbackMode;
  translateUserPrompts: boolean;
}

interface HeadlessAgentConfigTarget {
  setHeadlessMode(enabled: boolean): void;
  setModelId(modelId: string): void;
  setProvider(provider: ProviderType): void;
  setReasoningMode(mode: ReasoningMode): void;
  setToolFallbackMode(mode: ToolFallbackMode): void;
  setTranslationEnabled(enabled: boolean): void;
}

export const applyHeadlessAgentConfig = (
  target: HeadlessAgentConfigTarget,
  options: HeadlessRuntimeOptions
): void => {
  target.setHeadlessMode(true);

  if (options.provider) {
    target.setProvider(options.provider);
  }

  if (options.model) {
    target.setModelId(options.model);
  }

  if (options.reasoningMode !== null) {
    target.setReasoningMode(options.reasoningMode);
  }

  target.setToolFallbackMode(options.toolFallbackMode);
  target.setTranslationEnabled(options.translateUserPrompts);
};
