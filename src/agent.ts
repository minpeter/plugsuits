import { createFriendli } from "@friendliai/ai-provider";
import type { ModelMessage } from "ai";
import { ToolLoopAgent, wrapLanguageModel } from "ai";
import { getEnvironmentContext } from "./context/environment-context";
import { loadSkillsMetadata } from "./context/skills";
import { SYSTEM_PROMPT } from "./context/system-prompt";
import { env } from "./env";
import { buildMiddlewares } from "./middleware";
import {
  buildTodoContinuationPrompt,
  getIncompleteTodos,
} from "./middleware/todo-continuation";
import { tools } from "./tools";

export const DEFAULT_MODEL_ID = "Qwen/Qwen3-235B-A22B-Thinking-2507";
const OUTPUT_TOKEN_MAX = 64_000;

const friendli = createFriendli({
  apiKey: env.FRIENDLI_TOKEN,
  includeUsage: true,
});

const disableApprovalForTools = <T extends Record<string, unknown>>(
  toolsObj: T
): T => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(toolsObj)) {
    if (typeof value === "object" && value !== null) {
      result[key] = { ...value, needsApproval: false };
    } else {
      result[key] = value;
    }
  }
  return result as T;
};

interface CreateAgentOptions {
  disableApproval?: boolean;
  instructions?: string;
  enableThinking?: boolean;
  enableToolFallback?: boolean;
}

const createAgent = (modelId: string, options: CreateAgentOptions = {}) => {
  return new ToolLoopAgent({
    model: wrapLanguageModel({
      model: friendli(modelId),
      middleware: buildMiddlewares({
        enableToolFallback: options.enableToolFallback ?? false,
      }),
    }),
    instructions: options.instructions || SYSTEM_PROMPT,
    tools: options.disableApproval ? disableApprovalForTools(tools) : tools,
    maxOutputTokens: OUTPUT_TOKEN_MAX,
    providerOptions: {
      friendli: {
        chat_template_kwargs: {
          enable_thinking: options.enableThinking ?? true,
          thinking: options.enableThinking ?? true,
        },
      },
    },
  });
};

export type ModelType = "serverless" | "dedicated";

class AgentManager {
  private modelId: string = DEFAULT_MODEL_ID;
  private modelType: ModelType = "serverless";
  private headlessMode = false;
  private thinkingEnabled = false;
  private toolFallbackEnabled = false;

  getModelId(): string {
    return this.modelId;
  }

  setModelId(modelId: string): void {
    this.modelId = modelId;
  }

  getModelType(): ModelType {
    return this.modelType;
  }

  setModelType(type: ModelType): void {
    this.modelType = type;
  }

  setHeadlessMode(enabled: boolean): void {
    this.headlessMode = enabled;
  }

  isHeadlessMode(): boolean {
    return this.headlessMode;
  }

  setThinkingEnabled(enabled: boolean): void {
    this.thinkingEnabled = enabled;
  }

  isThinkingEnabled(): boolean {
    return this.thinkingEnabled;
  }

  setToolFallbackEnabled(enabled: boolean): void {
    this.toolFallbackEnabled = enabled;
  }

  isToolFallbackEnabled(): boolean {
    return this.toolFallbackEnabled;
  }

  async getInstructions(): Promise<string> {
    let instructions = SYSTEM_PROMPT + getEnvironmentContext();

    const skillMetadata = await loadSkillsMetadata();
    if (skillMetadata) {
      instructions += skillMetadata;
    }

    const incompleteTodos = await getIncompleteTodos();
    if (incompleteTodos.length > 0) {
      instructions += `\n\n${buildTodoContinuationPrompt(incompleteTodos)}`;
    }

    return instructions;
  }

  getTools() {
    return tools;
  }

  async stream(messages: ModelMessage[]) {
    const agent = createAgent(this.modelId, {
      disableApproval: this.headlessMode,
      instructions: await this.getInstructions(),
      enableThinking: this.thinkingEnabled,
      enableToolFallback: this.toolFallbackEnabled,
    });
    return agent.stream({ messages });
  }
}

export const agentManager = new AgentManager();
