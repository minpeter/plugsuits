import { createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderOptions as AiProviderOptions } from "@ai-sdk/provider-utils";
import {
  type CompactionConfig,
  computeSpeculativeStartRatio,
  createAgent,
  createModelSummarizer,
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
import { getFriendliApiModelId, getFriendliModelById } from "./friendli-models";
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

export const DEFAULT_MODEL_ID = "zai-org/GLM-5";
export const DEFAULT_ANTHROPIC_MODEL_ID = "claude-sonnet-4-6";

/**
 * Hard cap on output tokens sent to the API.
 * Even if a model supports more, we limit the actual request to this value
 * to preserve context space for input and keep compaction sane.
 * Also used as fallback when model-specific limits are not available.
 */
const OUTPUT_TOKEN_CAP = 64_000;
const DEFAULT_CONTEXT_LENGTH = 200_000;
const TRANSLATION_MAX_OUTPUT_TOKENS = 4000;

type ProviderOptions = AiProviderOptions | undefined;

export type AgentStreamOptions = Pick<
  HarnessAgentStreamOptions,
  "abortSignal" | "maxOutputTokens"
>;
export type AgentStreamResult = HarnessAgentStreamResult;

export type ProviderType = "friendli" | "anthropic";

/** Token limits shared across all provider types. */
export interface ModelTokenLimits {
  contextLength: number;
  maxCompletionTokens: number;
}

export interface AnthropicModelInfo extends ModelTokenLimits {
  id: string;
  name: string;
}

export const ANTHROPIC_MODELS: readonly AnthropicModelInfo[] = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Latest)",
    contextLength: 200_000,
    maxCompletionTokens: 64_000,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 (Latest)",
    contextLength: 200_000,
    maxCompletionTokens: 32_000,
  },
] as const;

const friendli = env.FRIENDLI_TOKEN
  ? createFriendli({
      apiKey: env.FRIENDLI_TOKEN,
      includeUsage: true,
      ...(env.FRIENDLI_BASE_URL ? { baseURL: env.FRIENDLI_BASE_URL } : {}),
    })
  : null;

const anthropic = env.ANTHROPIC_API_KEY
  ? createAnthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    })
  : null;

const ANTHROPIC_THINKING_BUDGET_TOKENS = 10_000;

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

const getModelMaxCompletionTokens = (
  modelId: string,
  provider: ProviderType
): number => {
  if (provider === "anthropic") {
    const model = ANTHROPIC_MODELS.find((m) => m.id === modelId);
    return model?.maxCompletionTokens ?? OUTPUT_TOKEN_CAP;
  }
  const model = getFriendliModelById(modelId);
  return model?.maxCompletionTokens ?? OUTPUT_TOKEN_CAP;
};

/**
 * Effective output token limit: min(model capability, hard cap).
 * Prevents models where maxCompletionTokens == contextLength
 * (e.g. GLM-5: 202K/202K) from consuming the entire context window.
 */
const getEffectiveMaxOutputTokens = (
  modelId: string,
  provider: ProviderType
): number => {
  return Math.min(
    getModelMaxCompletionTokens(modelId, provider),
    OUTPUT_TOKEN_CAP
  );
};

const getModelContextLength = (
  modelId: string,
  provider: ProviderType
): number => {
  if (provider === "anthropic") {
    const model = ANTHROPIC_MODELS.find((m) => m.id === modelId);
    return model?.contextLength ?? DEFAULT_CONTEXT_LENGTH;
  }
  const model = getFriendliModelById(modelId);
  return model?.contextLength ?? DEFAULT_CONTEXT_LENGTH;
};

const getCompactionReserveTokens = (
  modelId: string,
  provider: ProviderType
): number => {
  if (provider === "anthropic") {
    return getEffectiveMaxOutputTokens(modelId, provider);
  }

  const model = getFriendliModelById(modelId);
  return (
    model?.compactionReserveTokens ??
    getEffectiveMaxOutputTokens(modelId, provider)
  );
};

const getProviderOptions = (
  modelId: string,
  provider: ProviderType,
  reasoningMode: ReasoningMode
): { options: ProviderOptions; maxOutputTokens: number } => {
  const thinkingEnabled = reasoningMode !== "off";
  const effectiveMaxTokens = getEffectiveMaxOutputTokens(modelId, provider);

  const getAnthropicProviderOptions = (): ProviderOptions => {
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
        ? effectiveMaxTokens - ANTHROPIC_THINKING_BUDGET_TOKENS
        : effectiveMaxTokens,
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
    maxOutputTokens: effectiveMaxTokens,
  };
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
  private readonly friendliClient: ReturnType<typeof createFriendli> | null;
  private readonly anthropicClient: ReturnType<typeof createAnthropic> | null;

  constructor(
    friendliClient?: ReturnType<typeof createFriendli> | null,
    anthropicClient?: ReturnType<typeof createAnthropic> | null
  ) {
    // Use provided clients or fall back to module-level singletons
    this.friendliClient =
      friendliClient !== undefined ? friendliClient : friendli;
    this.anthropicClient =
      anthropicClient !== undefined ? anthropicClient : anthropic;
    this.applyBestReasoningModeForCurrentModel();
  }

  resetForTesting(): void {
    this.modelId = DEFAULT_MODEL_ID;
    this.modelType = "serverless";
    this.provider = "friendli";
    this.headlessMode = false;
    this.reasoningMode = DEFAULT_REASONING_MODE;
    this.toolRegistry = defaultToolRegistry;
    this.toolFallbackMode = DEFAULT_TOOL_FALLBACK_MODE;
    this.translationEnabled = true;
    this.applyBestReasoningModeForCurrentModel();
  }

  private applyBestReasoningModeForCurrentModel(): void {
    this.reasoningMode = selectBestReasoningMode(
      this.getSelectableReasoningModes()
    );
  }

  private getProviderModel(modelId: string, provider: ProviderType) {
    if (provider === "anthropic") {
      if (!this.anthropicClient) {
        throw new Error(
          "ANTHROPIC_API_KEY is not set. Please set it in your environment."
        );
      }
      return this.anthropicClient(modelId);
    }

    if (!this.friendliClient) {
      throw new Error(
        "FRIENDLI_TOKEN is not set. Please set it in your environment."
      );
    }
    // Resolve internal id (e.g. "test-8k") to actual API model id
    const apiModelId = getFriendliApiModelId(modelId);
    return this.friendliClient(apiModelId);
  }

  private buildModel(reasoningMode: ReasoningMode = this.reasoningMode) {
    const model = this.getProviderModel(this.modelId, this.provider);
    const { options, maxOutputTokens } = getProviderOptions(
      this.modelId,
      this.provider,
      reasoningMode
    );

    const wrappedModel = wrapLanguageModel({
      model,
      middleware: buildMiddlewares({
        toolFallbackMode: this.toolFallbackMode,
      }),
    });

    return { model: wrappedModel, providerOptions: options, maxOutputTokens };
  }

  /**
   * Get the token limits for the currently selected model.
   * Used by compaction and context management systems.
   */
  getModelTokenLimits(): ModelTokenLimits {
    return {
      contextLength: getModelContextLength(this.modelId, this.provider),
      maxCompletionTokens: getModelMaxCompletionTokens(
        this.modelId,
        this.provider
      ),
    };
  }

  /**
   * Build a CompactionConfig suitable for the current model's token limits.
   * Callers (CLI/headless) should apply this to their MessageHistory
   * whenever the model changes.
   */
  buildCompactionConfig(
    overrides?: Partial<CompactionConfig>
  ): CompactionConfig {
    const contextLength = getModelContextLength(this.modelId, this.provider);
    const compactionReserveTokens = getCompactionReserveTokens(
      this.modelId,
      this.provider
    );
    const summarizeFn = createModelSummarizer(
      this.getProviderModel(this.modelId, this.provider),
      {
        instructions: () => this.getInstructions(),
        contextLimit: contextLength,
      }
    );
    return {
      enabled: true,
      maxTokens: contextLength,
      reserveTokens: compactionReserveTokens,
      keepRecentTokens: Math.floor(contextLength * 0.3),
      speculativeStartRatio: computeSpeculativeStartRatio(
        contextLength,
        compactionReserveTokens
      ),
      summarizeFn,
      ...overrides,
    };
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
    const {
      model,
      providerOptions,
      maxOutputTokens: providerMaxOutputTokens,
    } = this.buildModel();

    // Use the smaller of caller's budget and provider cap.
    // Caller budget comes from harness context-window enforcement;
    // provider cap comes from model-specific limits.
    const effectiveMaxOutputTokens =
      options.maxOutputTokens != null
        ? Math.min(options.maxOutputTokens, providerMaxOutputTokens)
        : providerMaxOutputTokens;

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
      abortSignal: options.abortSignal,
      providerOptions,
      maxOutputTokens: effectiveMaxOutputTokens,
    });
  }
}

/**
 * Factory function for creating a fresh AgentManager instance with custom provider clients.
 * Useful for test isolation and multi-agent scenarios.
 *
 * @param options - Optional provider credentials and base URLs.
 *   If not provided, falls back to environment variables.
 * @returns A new AgentManager instance with fresh provider clients.
 *
 * @example
 * ```typescript
 * // Test isolation: create a fresh instance per test
 * const manager = createAgentManager({
 *   friendliToken: 'test-token',
 *   friendliBaseUrl: 'http://localhost:8080',
 * });
 * ```
 */
export function createAgentManager(options?: {
  friendliToken?: string;
  anthropicApiKey?: string;
  friendliBaseUrl?: string;
  anthropicBaseUrl?: string;
}): AgentManager {
  const friendliToken = options?.friendliToken ?? env.FRIENDLI_TOKEN;
  const friendliClient = friendliToken
    ? createFriendli({
        apiKey: friendliToken,
        includeUsage: true,
        ...((options?.friendliBaseUrl ?? env.FRIENDLI_BASE_URL)
          ? { baseURL: options?.friendliBaseUrl ?? env.FRIENDLI_BASE_URL }
          : {}),
      })
    : null;

  const anthropicApiKey = options?.anthropicApiKey ?? env.ANTHROPIC_API_KEY;
  const anthropicClient = anthropicApiKey
    ? createAnthropic({
        apiKey: anthropicApiKey,
        ...((options?.anthropicBaseUrl ?? env.ANTHROPIC_BASE_URL)
          ? { baseURL: options?.anthropicBaseUrl ?? env.ANTHROPIC_BASE_URL }
          : {}),
      })
    : null;

  return new AgentManager(friendliClient, anthropicClient);
}

export const agentManager = createAgentManager();
