import { createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderOptions as AiProviderOptions } from "@ai-sdk/provider-utils";
import { createFriendli } from "@friendliai/ai-provider";
import type { ModelMessage } from "ai";
import { generateText, stepCountIs, streamText, wrapLanguageModel } from "ai";
import { getEnvironmentContext } from "./context/environment-context";
import { loadSkillsMetadata } from "./context/skills";
import { SYSTEM_PROMPT } from "./context/system-prompt";
import { env } from "./env";
import {
  applyFriendliInterleavedField,
  buildFriendliChatTemplateKwargs,
  getFriendliSelectableReasoningModes,
} from "./friendli-reasoning";
import { buildMiddlewares } from "./middleware";
import {
  buildTodoContinuationPrompt,
  getIncompleteTodos,
} from "./middleware/todo-continuation";
import { DEFAULT_REASONING_MODE, type ReasoningMode } from "./reasoning-mode";
import {
  DEFAULT_TOOL_FALLBACK_MODE,
  LEGACY_ENABLED_TOOL_FALLBACK_MODE,
  type ToolFallbackMode,
} from "./tool-fallback-mode";
import { tools } from "./tools";

export const DEFAULT_MODEL_ID = "zai-org/GLM-5";
export const DEFAULT_ANTHROPIC_MODEL_ID = "claude-sonnet-4-6";
const OUTPUT_TOKEN_MAX = 64_000;
const TRANSLATION_MAX_OUTPUT_TOKENS = 4000;

const NON_ASCII_PATTERN = /[^\\x00-]/;

const TRANSLATION_SYSTEM_PROMPT =
  "Translate the user message to clear English so the original intent is preserved. Return only the translated text and nothing else.";

type CoreStreamResult = ReturnType<typeof streamText>;
type ProviderOptions = AiProviderOptions | undefined;

export interface AgentStreamOptions {
  abortSignal?: AbortSignal;
}

export interface AgentStreamResult {
  finishReason: CoreStreamResult["finishReason"];
  fullStream: CoreStreamResult["fullStream"];
  response: CoreStreamResult["response"];
}

export type ProviderType = "friendli" | "anthropic";

export const ANTHROPIC_MODELS = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Latest)" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6 (Latest)" },
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
  reasoningMode?: ReasoningMode;
  toolFallbackMode?: ToolFallbackMode;
}

interface TranslationInputResult {
  text: string;
  translated: boolean;
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
const ANTHROPIC_SELECTABLE_REASONING_MODES: ReasoningMode[] = ["off", "on"];

const isNonEnglishText = (input: string): boolean => {
  return NON_ASCII_PATTERN.test(input);
};

const isAnthropicWithReasoning = (
  modelId: string,
  provider: ProviderType,
  reasoningMode: ReasoningMode
): boolean => {
  const thinkingEnabled = reasoningMode !== "off";
  return (
    provider === "anthropic" && thinkingEnabled && !modelId.includes("opus")
  );
};

const getProviderOptions = (
  modelId: string,
  provider: ProviderType,
  reasoningMode: ReasoningMode
): { options: ProviderOptions; maxOutputTokens: number } => {
  const thinkingEnabled = reasoningMode !== "off";

  const getAnthropicProviderOptions = () => {
    if (!thinkingEnabled) {
      return undefined;
    }

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

  if (provider === "anthropic") {
    return {
      options: getAnthropicProviderOptions(),
      maxOutputTokens: isAnthropicWithReasoning(
        modelId,
        provider,
        reasoningMode
      )
        ? ANTHROPIC_MAX_OUTPUT_TOKENS - ANTHROPIC_THINKING_BUDGET_TOKENS
        : OUTPUT_TOKEN_MAX,
    };
  }

  const chatTemplateKwargs = buildFriendliChatTemplateKwargs(
    modelId,
    reasoningMode
  );

  return {
    options: chatTemplateKwargs
      ? {
          friendli: {
            chat_template_kwargs: chatTemplateKwargs,
          },
        }
      : undefined,
    maxOutputTokens: OUTPUT_TOKEN_MAX,
  };
};

const createBaseModel = (
  modelId: string,
  provider: ProviderType,
  toolFallbackMode: ToolFallbackMode,
  reasoningMode: ReasoningMode
) => {
  const model = getModel(modelId, provider);
  const { options, maxOutputTokens } = getProviderOptions(
    modelId,
    provider,
    reasoningMode
  );

  const wrappedModel = wrapLanguageModel({
    model,
    middleware: buildMiddlewares({
      toolFallbackMode,
    }),
  });

  return { wrappedModel, providerOptions: options, maxOutputTokens };
};

const createAgent = (modelId: string, options: CreateAgentOptions = {}) => {
  const provider = options.provider ?? "friendli";
  const reasoningMode =
    options.reasoningMode ??
    (options.enableThinking ? "on" : DEFAULT_REASONING_MODE);
  const toolFallbackMode =
    options.toolFallbackMode ?? DEFAULT_TOOL_FALLBACK_MODE;

  const { wrappedModel, providerOptions, maxOutputTokens } = createBaseModel(
    modelId,
    provider,
    toolFallbackMode,
    reasoningMode
  );

  return {
    stream: ({
      messages,
      abortSignal,
    }: { messages: ModelMessage[] } & AgentStreamOptions) => {
      const preparedMessages =
        provider === "friendli"
          ? applyFriendliInterleavedField(messages, modelId, reasoningMode)
          : messages;

      return streamText({
        model: wrappedModel,
        system: options.instructions ?? SYSTEM_PROMPT,
        tools,
        messages: preparedMessages,
        maxOutputTokens,
        providerOptions,
        // stepCountIs(n) replaces the deprecated maxSteps option.
        // It configures the stream to stop after n tool-call round-trips,
        // giving the model a single tool invocation cycle before returning.
        stopWhen: stepCountIs(1),
        abortSignal,
      });
    },
  };
};

const translateToEnglish = async (
  text: string,
  modelId: string,
  provider: ProviderType,
  toolFallbackMode: ToolFallbackMode
): Promise<string> => {
  const { wrappedModel, providerOptions } = createBaseModel(
    modelId,
    provider,
    toolFallbackMode,
    "off"
  );

  const result = await generateText({
    model: wrappedModel,
    system: TRANSLATION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: text,
      },
    ],
    maxOutputTokens: TRANSLATION_MAX_OUTPUT_TOKENS,
    providerOptions,
  });

  return result.text.trim();
};

export type ModelType = "serverless" | "dedicated";

class AgentManager {
  private modelId: string = DEFAULT_MODEL_ID;
  private modelType: ModelType = "serverless";
  private provider: ProviderType = "friendli";
  private headlessMode = false;
  private reasoningMode: ReasoningMode = DEFAULT_REASONING_MODE;
  private toolFallbackMode: ToolFallbackMode = DEFAULT_TOOL_FALLBACK_MODE;
  private userInputTranslationEnabled = false;

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

  setReasoningMode(mode: ReasoningMode): void {
    this.reasoningMode = mode;
  }

  getReasoningMode(): ReasoningMode {
    return this.reasoningMode;
  }

  getSelectableReasoningModes(): ReasoningMode[] {
    if (this.provider === "friendli") {
      return getFriendliSelectableReasoningModes(this.modelId);
    }
    return [...ANTHROPIC_SELECTABLE_REASONING_MODES];
  }

  setThinkingEnabled(enabled: boolean): void {
    this.reasoningMode = enabled ? "on" : DEFAULT_REASONING_MODE;
  }

  isThinkingEnabled(): boolean {
    return this.reasoningMode !== DEFAULT_REASONING_MODE;
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

  setUserInputTranslationEnabled(enabled: boolean): void {
    this.userInputTranslationEnabled = enabled;
  }

  isUserInputTranslationEnabled(): boolean {
    return this.userInputTranslationEnabled;
  }

  async preprocessUserInput(input: string): Promise<TranslationInputResult> {
    if (!(this.userInputTranslationEnabled && isNonEnglishText(input))) {
      return { text: input, translated: false };
    }

    try {
      const translated = await translateToEnglish(
        input,
        this.modelId,
        this.provider,
        this.toolFallbackMode
      );

      if (!translated || translated === input.trim()) {
        return { text: input, translated: false };
      }

      return { text: translated, translated: true };
    } catch {
      return { text: input, translated: false };
    }
  }

  async getInstructions(): Promise<string> {
    let instructions = SYSTEM_PROMPT + getEnvironmentContext();

    const skillMetadata = await loadSkillsMetadata();
    if (skillMetadata) {
      instructions += skillMetadata;
    }

    const incompleteTodos = await getIncompleteTodos();
    if (incompleteTodos.length > 0) {
      instructions += `

${buildTodoContinuationPrompt(incompleteTodos)}`;
    }

    return instructions;
  }

  getTools() {
    return tools;
  }

  async stream(
    messages: ModelMessage[],
    options: AgentStreamOptions = {}
  ): Promise<AgentStreamResult> {
    const agent = createAgent(this.modelId, {
      instructions: await this.getInstructions(),
      reasoningMode: this.reasoningMode,
      toolFallbackMode: this.toolFallbackMode,
      provider: this.provider,
    });
    return agent.stream({ messages, ...options });
  }
}

export const agentManager = new AgentManager();
