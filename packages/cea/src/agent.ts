import { createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderOptions as AiProviderOptions } from "@ai-sdk/provider-utils";
import {
  type CompactionConfig,
  computeAdaptiveThresholdRatio as computeAdaptiveThresholdRatioFromPolicy,
  computeCompactionMaxTokens as computeCompactionMaxTokensFromPolicy,
  computeSpeculativeStartRatio as computeSpeculativeStartRatioFromPolicy,
  createAgent,
  createModelSummarizer,
  estimateTokens,
  type AgentStreamOptions as HarnessAgentStreamOptions,
  type AgentStreamResult as HarnessAgentStreamResult,
  type PruningConfig,
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

interface BenchmarkSamplingOverrides {
  seed?: number;
  temperature?: number;
}

export type AgentStreamOptions = Pick<
  HarnessAgentStreamOptions,
  "abortSignal" | "maxOutputTokens"
>;
export type AgentStreamResult = HarnessAgentStreamResult;

export type ProviderType = "friendli" | "anthropic";

export interface UsageMeasurement {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const TOKEN_PROBE_SENTINEL = ".";

const getUsageNumber = (
  usage: Record<string, unknown>,
  ...keys: string[]
): number | undefined => {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
};

const normalizeUsageMeasurement = (usage: unknown): UsageMeasurement | null => {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const usageRecord = usage as Record<string, unknown>;
  const inputTokens = getUsageNumber(
    usageRecord,
    "inputTokens",
    "promptTokens"
  );
  const outputTokens = getUsageNumber(
    usageRecord,
    "outputTokens",
    "completionTokens"
  );
  const totalTokens = getUsageNumber(usageRecord, "totalTokens");

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens:
      totalTokens ?? Math.max(0, (inputTokens ?? 0) + (outputTokens ?? 0)),
  };
};

const getBenchmarkSamplingOverrides = (): BenchmarkSamplingOverrides => {
  const seed = process.env.BENCHMARK_SEED
    ? Number.parseInt(process.env.BENCHMARK_SEED, 10)
    : undefined;
  const temperature = process.env.BENCHMARK_TEMPERATURE
    ? Number.parseFloat(process.env.BENCHMARK_TEMPERATURE)
    : undefined;

  return {
    seed: Number.isFinite(seed) ? seed : undefined,
    temperature: Number.isFinite(temperature) ? temperature : undefined,
  };
};

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

interface FileTrackingToolCall {
  input: Record<string, unknown>;
  toolName: string;
  type: "tool-call";
}

const getFileTrackingToolCall = (
  part: unknown
): FileTrackingToolCall | null => {
  if (typeof part !== "object" || part === null) {
    return null;
  }

  const toolCall = part as Partial<FileTrackingToolCall>;
  if (toolCall.type !== "tool-call") {
    return null;
  }

  return toolCall as FileTrackingToolCall;
};

const getTrackedPath = (
  toolCall: FileTrackingToolCall
): { kind: "read" | "modified"; path: string } | null => {
  const path = toolCall.input?.path;
  if (typeof path !== "string" || path.length === 0) {
    return null;
  }

  if (toolCall.toolName === "read_file") {
    return { kind: "read", path };
  }

  if (["edit_file", "write_file", "delete_file"].includes(toolCall.toolName)) {
    return { kind: "modified", path };
  }

  return null;
};

function extractFileOpsFromMessages(
  messages: ModelMessage[],
  readFiles: Set<string>,
  modifiedFiles: Set<string>
): void {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      continue;
    }
    for (const part of msg.content) {
      const toolCall = getFileTrackingToolCall(part);
      if (!toolCall) {
        continue;
      }

      const trackedPath = getTrackedPath(toolCall);
      if (!trackedPath) {
        continue;
      }

      if (trackedPath.kind === "read") {
        readFiles.add(trackedPath.path);
      } else {
        modifiedFiles.add(trackedPath.path);
      }
    }
  }
}

export function buildFileTrackingSummarizeFn(
  modelSummarizer: (
    messages: ModelMessage[],
    previousSummary?: string
  ) => Promise<string>
): {
  summarizeFn: (
    messages: ModelMessage[],
    previousSummary?: string
  ) => Promise<string>;
  getStructuredState: () => string | undefined;
} {
  const allReadFiles = new Set<string>();
  const allModifiedFiles = new Set<string>();

  const summarizeFn = async (
    messages: ModelMessage[],
    previousSummary?: string
  ): Promise<string> => {
    extractFileOpsFromMessages(messages, allReadFiles, allModifiedFiles);

    const readList = [...allReadFiles].slice(0, 20);
    const modifiedList = [...allModifiedFiles].slice(0, 20);

    const fileContext = [
      readList.length > 0
        ? `<read-files>\n${readList.join(", ")}\n</read-files>`
        : "",
      modifiedList.length > 0
        ? `<modified-files>\n${modifiedList.join(", ")}\n</modified-files>`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const summary = await modelSummarizer(messages, previousSummary);
    return fileContext ? `${fileContext}\n\n${summary}` : summary;
  };

  const getStructuredState = (): string | undefined => {
    const parts: string[] = [];

    if (allReadFiles.size > 0 || allModifiedFiles.size > 0) {
      parts.push("## Current File Operations");
      if (allReadFiles.size > 0) {
        parts.push(`READ: ${[...allReadFiles].slice(0, 20).join(", ")}`);
      }
      if (allModifiedFiles.size > 0) {
        parts.push(
          `MODIFIED: ${[...allModifiedFiles].slice(0, 20).join(", ")}`
        );
      }
    }

    return parts.length > 0 ? parts.join("\n") : undefined;
  };

  return { summarizeFn, getStructuredState };
}

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
   * Parse CONTEXT_LIMIT_OVERRIDE when COMPACTION_DEBUG is active.
   * Returns the override value if valid, or null if not applicable.
   */
  private getContextLimitOverride(): number | null {
    if (
      (process.env.COMPACTION_DEBUG === "1" ||
        process.env.COMPACTION_DEBUG === "true") &&
      process.env.CONTEXT_LIMIT_OVERRIDE
    ) {
      const override = Number.parseInt(process.env.CONTEXT_LIMIT_OVERRIDE, 10);
      if (Number.isFinite(override) && override > 0) {
        return override;
      }
    }
    return null;
  }

  /**
   * Get the token limits for the currently selected model.
   * Used by compaction and context management systems.
   */
  getModelTokenLimits(): ModelTokenLimits {
    const contextLength =
      this.getContextLimitOverride() ??
      getModelContextLength(this.modelId, this.provider);

    return {
      contextLength,
      maxCompletionTokens: getModelMaxCompletionTokens(
        this.modelId,
        this.provider
      ),
    };
  }

  buildCompactionConfig(
    overrides?: Partial<CompactionConfig>
  ): CompactionConfig {
    const contextLength = getModelContextLength(this.modelId, this.provider);
    const compactionReserveTokens = getCompactionReserveTokens(
      this.modelId,
      this.provider
    );

    const contextOverride = this.getContextLimitOverride();
    const effectiveContextLength = contextOverride ?? contextLength;
    let effectiveReserveTokens = compactionReserveTokens;
    if (contextOverride !== null) {
      const ratio = effectiveContextLength / contextLength;
      const scaledReserve = Math.max(
        256,
        Math.floor(compactionReserveTokens * ratio)
      );
      effectiveReserveTokens = Math.min(
        scaledReserve,
        Math.floor(effectiveContextLength * 0.15)
      );
      console.error(
        `[compaction-debug] contextLimit overridden: ${contextLength} → ${effectiveContextLength}, reserve=${effectiveReserveTokens}, keepRecent=${Math.floor(effectiveContextLength * 0.3)}`
      );
    }

    const baseModelSummarizer = createModelSummarizer(
      this.getProviderModel(this.modelId, this.provider),
      {
        instructions: () => this.getInstructions(),
        contextLimit: effectiveContextLength,
      }
    );
    const { summarizeFn, getStructuredState } =
      buildFileTrackingSummarizeFn(baseModelSummarizer);

    // Compute context-adaptive threshold ratio
    const thresholdRatio = computeAdaptiveThresholdRatio(
      effectiveContextLength
    );

    // Backward compatibility: keep maxTokens computed from old formula
    const maxTokens = computeCompactionMaxTokens(
      effectiveContextLength,
      effectiveReserveTokens
    );

    const keepRecentTokens = Math.min(
      Math.floor(effectiveContextLength * 0.3),
      Math.max(512, Math.floor(effectiveContextLength * thresholdRatio * 0.3))
    );

    return {
      contextLimit: effectiveContextLength,
      enabled: true,
      maxTokens,
      thresholdRatio,
      reserveTokens: effectiveReserveTokens,
      keepRecentTokens,
      speculativeStartRatio: computeSpeculativeStartRatio(
        effectiveContextLength,
        effectiveReserveTokens
      ),
      summarizeFn,
      getStructuredState,
      ...overrides,
    };
  }

  buildPruningConfig(overrides?: Partial<PruningConfig>): PruningConfig {
    return {
      eagerPruneToolNames: ["read_file", "grep_files"],
      enabled: true,
      protectRecentTokens: 40_000,
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

    if (preparedMessages.length === 0) {
      throw new Error(
        "Cannot call the model with an empty message list after context preparation."
      );
    }

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
      ...getBenchmarkSamplingOverrides(),
    });
  }

  async measureUsage(
    messages: ModelMessage[]
  ): Promise<UsageMeasurement | null> {
    const probeMessages =
      messages.length > 0
        ? messages
        : ([
            {
              role: "user",
              content: TOKEN_PROBE_SENTINEL,
            },
          ] satisfies ModelMessage[]);
    const { model, providerOptions } = this.buildModel("off");
    const preparedMessages =
      this.provider === "friendli"
        ? applyFriendliInterleavedField(
            probeMessages,
            this.modelId,
            DEFAULT_REASONING_MODE
          )
        : probeMessages;

    const agent = createAgent({
      model,
      tools: this.toolRegistry,
      instructions: await this.getInstructions(),
      maxStepsPerTurn: 1,
      experimental_repairToolCall: repairToolCall,
    });
    const stream = agent.stream({
      messages: preparedMessages,
      providerOptions,
      maxOutputTokens: 1,
    });
    const usage = normalizeUsageMeasurement(
      await Promise.all([stream.usage, stream.response]).then(
        ([resolvedUsage]) => {
          return resolvedUsage;
        }
      )
    );

    if (!usage) {
      return null;
    }

    if (messages.length > 0) {
      return usage;
    }

    const probeMessageTokens = estimateTokens(TOKEN_PROBE_SENTINEL);
    const inputTokens = Math.max(0, usage.inputTokens - probeMessageTokens);
    return {
      inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: inputTokens + usage.outputTokens,
    };
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

export const computeAdaptiveThresholdRatio = (contextLength: number): number =>
  computeAdaptiveThresholdRatioFromPolicy(contextLength);

export const computeCompactionMaxTokens = (
  contextLength: number,
  reserveTokens: number
): number => computeCompactionMaxTokensFromPolicy(contextLength, reserveTokens);

export const computeSpeculativeStartRatio = (
  contextLength: number,
  reserveTokens: number
): number =>
  computeSpeculativeStartRatioFromPolicy(contextLength, reserveTokens);
