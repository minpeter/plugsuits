import type { Interface as ReadlineInterface } from "node:readline";
import { friendli } from "@friendliai/ai-provider";
import type { LanguageModel } from "ai";
import { colorize } from "./colors";

export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
}

function question(rl: ReadlineInterface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

export async function fetchAvailableModels(): Promise<ModelInfo[]> {
  const { models } = await friendli.getAvailableModels();

  if (!models || models.length === 0) {
    return [];
  }

  return models.map((model: Record<string, unknown>) => ({
    id: String(model.id ?? model.name ?? model.modelId ?? "unknown"),
    name: model.name ? String(model.name) : undefined,
    description: model.description ? String(model.description) : undefined,
  }));
}

export interface ModelSelection {
  model: LanguageModel;
  modelId: string;
}

export async function selectModel(
  rl: ReadlineInterface,
  currentModelId?: string
): Promise<ModelSelection | null> {
  console.log(colorize("cyan", "Fetching available models..."));

  try {
    const models = await fetchAvailableModels();

    if (models.length === 0) {
      console.log(colorize("yellow", "No models available."));
      return null;
    }

    console.log(colorize("cyan", `\nAvailable models (${models.length}):`));

    for (const [index, model] of models.entries()) {
      const isCurrent = model.id === currentModelId;
      const marker = isCurrent ? colorize("green", " (current)") : "";
      console.log(`  ${index + 1}. ${model.id}${marker}`);
    }

    console.log();
    const answer = await question(
      rl,
      colorize(
        "yellow",
        "Select a model by number (or press Enter to cancel): "
      )
    );

    const trimmed = answer.trim();
    if (trimmed === "") {
      console.log(colorize("yellow", "Model selection cancelled."));
      return null;
    }

    const selectedIndex = Number.parseInt(trimmed, 10) - 1;

    if (
      Number.isNaN(selectedIndex) ||
      selectedIndex < 0 ||
      selectedIndex >= models.length
    ) {
      console.log(colorize("red", "Invalid selection."));
      return null;
    }

    const selectedModel = models[selectedIndex];
    console.log(colorize("green", `\nSelected model: ${selectedModel.id}`));

    return {
      model: friendli(selectedModel.id),
      modelId: selectedModel.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(colorize("red", `Error fetching models: ${message}`));
    return null;
  }
}
