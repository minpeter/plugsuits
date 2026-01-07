import { agentManager } from "../agent";
import { env } from "../env";
import { colorize } from "../interaction/colors";
import type { Command, CommandResult } from "./types";

interface ModelInfo {
  id: string;
  name?: string;
}

let cachedModels: ModelInfo[] | null = null;

async function fetchAvailableModels(): Promise<ModelInfo[]> {
  if (cachedModels) {
    return cachedModels;
  }

  const response = await fetch("https://api.friendli.ai/serverless/v1/models", {
    headers: {
      Authorization: `Bearer ${env.FRIENDLI_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status}`);
  }

  const data = (await response.json()) as { data: { id: string }[] };
  cachedModels = data.data.map((m) => ({ id: m.id }));
  return cachedModels;
}

function formatModelList(models: ModelInfo[], currentModelId: string): string {
  const lines = models.map((model, index) => {
    const isCurrent = model.id === currentModelId;
    const marker = isCurrent ? colorize("green", " (current)") : "";
    return `  ${index + 1}. ${model.id}${marker}`;
  });

  return `Available models:\n${lines.join("\n")}\n\nUsage: /model <number> to select`;
}

export const createModelCommand = (): Command => ({
  name: "model",
  description: "List or change the AI model",
  execute: async ({ args }): Promise<CommandResult> => {
    try {
      const models = await fetchAvailableModels();

      if (models.length === 0) {
        return { success: false, message: "No models available." };
      }

      const currentModelId = agentManager.getModelId();

      if (args.length === 0) {
        return {
          success: true,
          message: formatModelList(models, currentModelId),
        };
      }

      const selection = args[0];
      const selectedIndex = Number.parseInt(selection, 10) - 1;

      let selectedModel: ModelInfo | undefined;

      if (
        !Number.isNaN(selectedIndex) &&
        selectedIndex >= 0 &&
        selectedIndex < models.length
      ) {
        selectedModel = models[selectedIndex];
      } else {
        selectedModel = models.find((m) => m.id === selection);
      }

      if (!selectedModel) {
        return {
          success: false,
          message: `Invalid selection: ${selection}`,
        };
      }

      if (selectedModel.id === currentModelId) {
        return {
          success: true,
          message: `Already using model: ${selectedModel.id}`,
        };
      }

      agentManager.setModelId(selectedModel.id);
      return {
        success: true,
        message: colorize("green", `Model changed to: ${selectedModel.id}`),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message: `Error: ${message}` };
    }
  },
});
