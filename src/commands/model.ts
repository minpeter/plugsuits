import type { ProviderType } from "../agent";
import { ANTHROPIC_MODELS, agentManager } from "../agent";
import { colorize } from "../interaction/colors";
import type { Command, CommandResult } from "./types";

export interface ModelInfo {
  id: string;
  name?: string;
  provider: ProviderType;
  type?: "serverless" | "dedicated";
}

const FRIENDLI_MODELS: readonly ModelInfo[] = [
  {
    id: "MiniMaxAI/MiniMax-M2.5",
    name: "MiniMax M2.5",
    provider: "friendli",
    type: "serverless",
  },
  {
    id: "MiniMaxAI/MiniMax-M2.1",
    name: "MiniMax M2.1",
    provider: "friendli",
    type: "serverless",
  },
  {
    id: "zai-org/GLM-5",
    name: "GLM 5",
    provider: "friendli",
    type: "serverless",
  },
  {
    id: "zai-org/GLM-4.7",
    name: "GLM 4.7",
    provider: "friendli",
    type: "serverless",
  },
] as const;

function getAnthropicModels(): ModelInfo[] {
  return ANTHROPIC_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    provider: "anthropic" as const,
  }));
}

export function getAvailableModels(): ModelInfo[] {
  const anthropicModels = getAnthropicModels();

  return [...anthropicModels, ...FRIENDLI_MODELS];
}

export function findModelBySelection(
  selection: string,
  models: ModelInfo[] = getAvailableModels()
): ModelInfo | undefined {
  const selectedIndex = Number.parseInt(selection, 10) - 1;

  if (
    !Number.isNaN(selectedIndex) &&
    selectedIndex >= 0 &&
    selectedIndex < models.length
  ) {
    return models[selectedIndex];
  }

  return models.find((m) => m.id === selection);
}

const getProviderLabel = (provider: ProviderType): string => {
  const providerLabels: Record<ProviderType, string> = {
    anthropic: "Anthropic",
    friendli: "FriendliAI",
  };
  return providerLabels[provider];
};

export const applyModelSelection = (
  selectedModel: ModelInfo
): CommandResult => {
  const currentModelId = agentManager.getModelId();
  const currentProvider = agentManager.getProvider();

  if (
    selectedModel.id === currentModelId &&
    selectedModel.provider === currentProvider
  ) {
    return {
      success: true,
      message: `Already using model: ${selectedModel.id}`,
    };
  }

  if (selectedModel.provider !== currentProvider) {
    agentManager.setProvider(selectedModel.provider);
  }

  agentManager.setModelId(selectedModel.id);
  if (selectedModel.type) {
    agentManager.setModelType(selectedModel.type);
  }

  const providerLabel = getProviderLabel(selectedModel.provider);
  return {
    success: true,
    message: colorize(
      "green",
      `Model changed to: ${selectedModel.id} (${providerLabel})`
    ),
  };
};

function formatModelList(
  models: ModelInfo[],
  currentModelId: string,
  currentProvider: ProviderType
): string {
  const lines = models.map((model, index) => {
    const isCurrent =
      model.id === currentModelId && model.provider === currentProvider;
    const marker = isCurrent ? colorize("green", " (current)") : "";
    let providerLabel: string;
    if (model.provider === "anthropic") {
      providerLabel = colorize("magenta", " [Anthropic]");
    } else if (model.type === "dedicated") {
      providerLabel = colorize("cyan", " [FDE]");
    } else {
      providerLabel = colorize("blue", " [FriendliAI]");
    }
    const nameLabel = model.name ? ` - ${model.name}` : "";
    return `  ${index + 1}. ${model.id}${nameLabel}${providerLabel}${marker}`;
  });

  return `Available models:\n${lines.join("\n")}\n\nUsage: /model <number> to select`;
}

export const createModelCommand = (): Command => ({
  name: "model",
  description: "List or change the AI model",
  execute: ({ args }): CommandResult => {
    const models = getAvailableModels();

    if (models.length === 0) {
      return { success: false, message: "No models available." };
    }

    const currentModelId = agentManager.getModelId();
    const currentProvider = agentManager.getProvider();

    if (args.length === 0) {
      return {
        success: true,
        message: formatModelList(models, currentModelId, currentProvider),
      };
    }

    const selection = args[0];
    const selectedModel = findModelBySelection(selection, models);

    if (!selectedModel) {
      return {
        success: false,
        message: `Invalid selection: ${selection}`,
      };
    }

    return applyModelSelection(selectedModel);
  },
});
