import { createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderOptions as AiProviderOptions } from "@ai-sdk/provider-utils";
import {
  createAgent,
  type AgentStreamOptions as HarnessAgentStreamOptions,
  type AgentStreamResult as HarnessAgentStreamResult,
} from "@ai-sdk-tool/harness";
import { createFriendli } from "@friendliai/ai-provider";
import {
  InvalidToolInputError,
  type ModelMessage,
  NoSuchToolError,
  wrapLanguageModel,
} from "ai";
import { getEnvironmentContext } from "./context/environment-context";
import { loadSkillsMetadata } from "./context/skills";
import { SYSTEM_PROMPT } from "./context/system-prompt";
import type { TranslationModelConfig } from "./context/translation";
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
import { createTools, type ToolRegistry } from "./tools";

export const DEFAULT_MODEL_ID = "MiniMaxAI/MiniMax-M2.5";
export const DEFAULT_ANTHROPIC_MODEL_ID = "claude-sonnet-4-6";
const OUTPUT_TOKEN_MAX = 64_000;
const TRANSLATION_MAX_OUTPUT_TOKENS = 4000;

type ProviderOptions = AiProviderOptions | undefined;

export type AgentStreamOptions = Pick<HarnessAgentStreamOptions, "abortSignal">;
export type AgentStreamResult = HarnessAgentStreamResult;

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
const REASONING_MODE_PRIORITY: readonly ReasoningMode[] = [
  "preserved",
  "interleaved",
  "on",
  "off",
];
const TRANSLATION_REASONING_MODE_PRIORITY: readonly ReasoningMode[] = [
  "off",
  "on",
];

const selectBestReasoningMode = (
  modes: readonly ReasoningMode[]
): ReasoningMode => {
  for (const mode of REASONING_MODE_PRIORITY) {
    if (modes.includes(mode)) {
      return mode;
    }
  }

  return DEFAULT_REASONING_MODE;
};

export const selectTranslationReasoningMode = (
  modes: readonly ReasoningMode[]
): ReasoningMode => {
  for (const mode of TRANSLATION_REASONING_MODE_PRIORITY) {
    if (modes.includes(mode)) {
      return mode;
    }
  }

  return selectBestReasoningMode(modes);
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

  return { model: wrappedModel, providerOptions: options, maxOutputTokens };
};

const defaultToolRegistry = createTools();

/**
 * Repair malformed tool calls from weak models.
 * Cleans hashline artifacts (e.g. `42#AB|content42#AB`) that models
 * sometimes embed in JSON arguments.
 */
const repairToolCall: Parameters<
  typeof import("ai").streamText
>[0]["experimental_repairToolCall"] = ({ toolCall, error }) => {
  if (NoSuchToolError.isInstance(error)) {
    return Promise.resolve(null);
  }
  if (!InvalidToolInputError.isInstance(error)) {
    return Promise.resolve(null);
  }
  try {
    const raw =
      typeof toolCall.input === "string"
        ? toolCall.input
        : JSON.stringify(toolCall.input);
    const cleaned = raw
      .replace(
        /(\d+#[A-Z]{2})(?:[|=-][^"{}[\]]*?)\1(?:[|=-][^"{}[\]]*?)*/g,
        "$1"
      )
      .replace(/(\d+#[A-Z]{2})(?:-\1)+/g, "$1");
    const parsed = JSON.parse(cleaned);
    return Promise.resolve({ ...toolCall, input: JSON.stringify(parsed) });
  } catch {
    return Promise.resolve(null);
  }
};

export type ModelType = "serverless" | "dedicated";

export class AgentManager {
  private modelId: string = DEFAULT_MODEL_ID;
  private modelType: ModelType = "serverless";
  private provider: ProviderType = "friendli";
  private headlessMode = false;
  private reasoningMode: ReasoningMode = DEFAULT_REASONING_MODE;
  private toolRegistry: ToolRegistry = defaultToolRegistry;
  private toolFallbackMode: ToolFallbackMode = DEFAULT_TOOL_FALLBACK_MODE;
  private translationEnabled = true;

  constructor() {
    this.applyBestReasoningModeForCurrentModel();
  }

  private applyBestReasoningModeForCurrentModel(): void {
    this.reasoningMode = selectBestReasoningMode(
      this.getSelectableReasoningModes()
    );
  }

  private buildModel(reasoningMode: ReasoningMode = this.reasoningMode) {
    return createBaseModel(
      this.modelId,
      this.provider,
      this.toolFallbackMode,
      reasoningMode
    );
  }

  getModelId(): string {
    return this.modelId;
  }

  setModelId(modelId: string): void {
    this.modelId = modelId;
    this.applyBestReasoningModeForCurrentModel();
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

    this.applyBestReasoningModeForCurrentModel();
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

  setTranslationEnabled(enabled: boolean): void {
    this.translationEnabled = enabled;
  }

  isTranslationEnabled(): boolean {
    return this.translationEnabled;
  }

  getTranslationReasoningMode(): ReasoningMode {
    return selectTranslationReasoningMode(this.getSelectableReasoningModes());
  }

  getTranslationModelConfig(): TranslationModelConfig {
    const translationReasoningMode = this.getTranslationReasoningMode();
    const { model, providerOptions } = this.buildModel(
      translationReasoningMode
    );

    return {
      model,
      providerOptions,
      maxOutputTokens: TRANSLATION_MAX_OUTPUT_TOKENS,
    };
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

  getTools(): ToolRegistry {
    return this.toolRegistry;
  }

  setTools(toolRegistry: ToolRegistry): void {
    this.toolRegistry = toolRegistry;
  }

  async stream(
    messages: ModelMessage[],
    options: AgentStreamOptions = {}
  ): Promise<AgentStreamResult> {
    const { model, providerOptions, maxOutputTokens } = this.buildModel();
    const preparedMessages =
      this.provider === "friendli"
        ? applyFriendliInterleavedField(
            messages,
            this.modelId,
            this.reasoningMode
          )
        : messages;

    const agent = createAgent({
      model,
      tools: this.toolRegistry,
      instructions: await this.getInstructions(),
      maxStepsPerTurn: 1,
      experimental_repairToolCall: repairToolCall,
    });

    return agent.stream({
      messages: preparedMessages,
      ...options,
      providerOptions,
      maxOutputTokens,
    });
  }
}

export const agentManager = new AgentManager();
