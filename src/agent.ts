import { createAnthropic } from "@ai-sdk/anthropic";
import { createFriendli } from "@friendliai/ai-provider";
import type { ModelMessage } from "ai";
import { stepCountIs, streamText, wrapLanguageModel } from "ai";
import { getEnvironmentContext } from "./context/environment-context";
import { loadSkillsMetadata } from "./context/skills";
import { SYSTEM_PROMPT } from "./context/system-prompt";
import { env } from "./env";
import { buildMiddlewares } from "./middleware";
import {
  buildTodoContinuationPrompt,
  getIncompleteTodos,
} from "./middleware/todo-continuation";
import {
  DEFAULT_TOOL_FALLBACK_MODE,
  LEGACY_ENABLED_TOOL_FALLBACK_MODE,
  type ToolFallbackMode,
} from "./tool-fallback-mode";
import { tools } from "./tools";

export const DEFAULT_MODEL_ID = "MiniMaxAI/MiniMax-M2.5";
export const DEFAULT_ANTHROPIC_MODEL_ID = "claude-sonnet-4-5-20250929";
const OUTPUT_TOKEN_MAX = 64_000;

type CoreStreamResult = ReturnType<typeof streamText>;

interface AgentStreamOptions {
  abortSignal?: AbortSignal;
}

export interface AgentStreamResult {
  finishReason: CoreStreamResult["finishReason"];
  fullStream: CoreStreamResult["fullStream"];
  response: CoreStreamResult["response"];
}

export type ProviderType = "friendli" | "anthropic";

export const ANTHROPIC_MODELS = [
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 (Latest)" },
  { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5 (Latest)" },
] as const;

const friendli = env.FRIENDLI_TOKEN
  ? createFriendli({
      apiKey: env.FRIENDLI_TOKEN,
      includeUsage: true,
    })
  : null;

const anthropic = env.ANTHROPIC_API_KEY
  ? createAnthropic({
      apiKey: env.ANTHROPIC_API_KEY,
    })
  : null;

interface CreateAgentOptions {
  enableThinking?: boolean;
  instructions?: string;
  provider?: ProviderType;
  toolFallbackMode?: ToolFallbackMode;
}

const getModel = (modelId: string, provider: ProviderType) => {
  if (provider === "anthropic") {
    if (!anthropic) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Please set it in your environment."
      );
    }
    return anthropic(modelId);
  }

  if (!friendli) {
    throw new Error(
      "FRIENDLI_TOKEN is not set. Please set it in your environment."
    );
  }
  return friendli(modelId);
};

const ANTHROPIC_THINKING_BUDGET_TOKENS = 10_000;
const ANTHROPIC_MAX_OUTPUT_TOKENS = 64_000;

const createAgent = (modelId: string, options: CreateAgentOptions = {}) => {
  const provider = options.provider ?? "friendli";
  const thinkingEnabled = options.enableThinking ?? false;
  const model = getModel(modelId, provider);

  const getAnthropicProviderOptions = () => {
    if (!thinkingEnabled) {
      return undefined;
    }

    // Opus 4.5: use effort parameter
    // Sonnet 4.5: use thinking with budgetTokens
    const isOpus = modelId.includes("opus");
    if (isOpus) {
      return { anthropic: { effort: "high" } };
    }
    return {
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS,
        },
      },
    };
  };

  const getProviderOptions = () => {
    if (provider === "anthropic") {
      return getAnthropicProviderOptions();
    }
    return {
      friendli: {
        chat_template_kwargs: {
          enable_thinking: thinkingEnabled,
          thinking: thinkingEnabled,
        },
      },
    };
  };

  const providerOptions = getProviderOptions();

  // Anthropic with thinking: maxOutputTokens + thinkingBudget must be <= 64000
  const isAnthropicWithThinking =
    provider === "anthropic" && thinkingEnabled && !modelId.includes("opus");
  const maxOutputTokens = isAnthropicWithThinking
    ? ANTHROPIC_MAX_OUTPUT_TOKENS - ANTHROPIC_THINKING_BUDGET_TOKENS
    : OUTPUT_TOKEN_MAX;

  const wrappedModel = wrapLanguageModel({
    model,
    middleware: buildMiddlewares({
      toolFallbackMode: options.toolFallbackMode ?? DEFAULT_TOOL_FALLBACK_MODE,
    }),
  });

  return {
    stream: ({ messages, abortSignal }: { messages: ModelMessage[] } & AgentStreamOptions) => {
      return streamText({
        model: wrappedModel,
        system: options.instructions || SYSTEM_PROMPT,
        tools,
        messages,
        maxOutputTokens,
        providerOptions,
        stopWhen: stepCountIs(1),
        abortSignal,
      });
    },
  };
};

export type ModelType = "serverless" | "dedicated";

class AgentManager {
  private modelId: string = DEFAULT_MODEL_ID;
  private modelType: ModelType = "serverless";
  private provider: ProviderType = "friendli";
  private headlessMode = false;
  private thinkingEnabled = false;
  private toolFallbackMode: ToolFallbackMode = DEFAULT_TOOL_FALLBACK_MODE;

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

  getProvider(): ProviderType {
    return this.provider;
  }

  setProvider(provider: ProviderType): void {
    this.provider = provider;
    if (provider === "anthropic") {
      this.modelId = DEFAULT_ANTHROPIC_MODEL_ID;
    } else {
      this.modelId = DEFAULT_MODEL_ID;
    }
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

  getToolFallbackMode(): ToolFallbackMode {
    return this.toolFallbackMode;
  }

  setToolFallbackMode(mode: ToolFallbackMode): void {
    this.toolFallbackMode = mode;
  }

  setToolFallbackEnabled(enabled: boolean): void {
    this.toolFallbackMode = enabled
      ? LEGACY_ENABLED_TOOL_FALLBACK_MODE
      : DEFAULT_TOOL_FALLBACK_MODE;
  }

  isToolFallbackEnabled(): boolean {
    return this.toolFallbackMode !== DEFAULT_TOOL_FALLBACK_MODE;
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

  async stream(messages: ModelMessage[], options: AgentStreamOptions = {}): Promise<AgentStreamResult> {
    const agent = createAgent(this.modelId, {
      instructions: await this.getInstructions(),
      enableThinking: this.thinkingEnabled,
      toolFallbackMode: this.toolFallbackMode,
      provider: this.provider,
    });
    return agent.stream({ messages, ...options });
  }
}

export const agentManager = new AgentManager();
