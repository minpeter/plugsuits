import { createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderOptions as AiProviderOptions } from "@ai-sdk/provider-utils";
import {
  type AgentModelProfile,
  addEphemeralCacheControlToLastMessage,
  BackgroundMemoryExtractor,
  type CompactionConfig,
  computeAdaptiveThresholdRatio as computeAdaptiveThresholdRatioFromPolicy,
  computeCompactionMaxTokens as computeCompactionMaxTokensFromPolicy,
  computeSpeculativeStartRatio as computeSpeculativeStartRatioFromPolicy,
  createAgent,
  createDefaultPruningConfig,
  createModelSummarizer,
  estimateTokens,
  type FileMemoryStore,
  type AgentStreamOptions as HarnessAgentStreamOptions,
  type AgentStreamResult as HarnessAgentStreamResult,
  mergeAgentModelProfile,
  type PruningConfig,
} from "@ai-sdk-tool/harness";
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

export const DEFAULT_ANTHROPIC_MODEL_ID = "claude-sonnet-4-6";
export const DEFAULT_MODEL_ID = DEFAULT_ANTHROPIC_MODEL_ID;

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
  | "abortSignal"
  | "experimentalContext"
  | "maxOutputTokens"
  | "providerOptions"
  | "seed"
  | "system"
  | "temperature"
>;
export type AgentStreamResult = HarnessAgentStreamResult;

export type ProviderType = "anthropic";

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
  const inputTokens = getUsageNumber(usageRecord, "inputTokens");
  const outputTokens = getUsageNumber(usageRecord, "outputTokens");
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
  return {
    seed: env.BENCHMARK_SEED,
    temperature: env.BENCHMARK_TEMPERATURE,
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

const getModelMaxCompletionTokens = (modelId: string): number => {
  const model = ANTHROPIC_MODELS.find((m) => m.id === modelId);
  return model?.maxCompletionTokens ?? OUTPUT_TOKEN_CAP;
};

const getEffectiveMaxOutputTokens = (modelId: string): number => {
  return Math.min(getModelMaxCompletionTokens(modelId), OUTPUT_TOKEN_CAP);
};

const getModelContextLength = (modelId: string): number => {
  const model = ANTHROPIC_MODELS.find((m) => m.id === modelId);
  return model?.contextLength ?? DEFAULT_CONTEXT_LENGTH;
};

const getCompactionReserveTokens = (modelId: string): number => {
  return getEffectiveMaxOutputTokens(modelId);
};

const getProviderOptions = (
  modelId: string,
  provider: ProviderType,
  reasoningMode: ReasoningMode
): { options: ProviderOptions; maxOutputTokens: number } => {
  const thinkingEnabled = reasoningMode !== "off";
  const effectiveMaxTokens = getEffectiveMaxOutputTokens(modelId);

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

  return {
    options: getAnthropicProviderOptions(),
    maxOutputTokens: isAnthropicWithReasoning(modelId, provider, reasoningMode)
      ? effectiveMaxTokens - ANTHROPIC_THINKING_BUDGET_TOKENS
      : effectiveMaxTokens,
  };
};

const fallbackAddEphemeralCacheControlToLastMessage = (params: {
  messages: ModelMessage[];
  model: ReturnType<AgentManager["buildModel"]>["model"];
}): ModelMessage[] => {
  const modelRecord = params.model as Record<string, unknown>;
  const provider = modelRecord.provider;
  const modelId = modelRecord.modelId;
  const isAnthropic = [provider, modelId].some((value) => {
    return (
      typeof value === "string" &&
      (value.includes("anthropic") || value.includes("claude"))
    );
  });

  if (!isAnthropic || params.messages.length === 0) {
    return params.messages;
  }

  return params.messages.map((message, index) => {
    if (index !== params.messages.length - 1) {
      return message;
    }

    return {
      ...message,
      providerOptions: {
        ...(message.providerOptions ?? {}),
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    } as ModelMessage;
  });
};

const applyLastMessageCacheControl = (params: {
  messages: ModelMessage[];
  model: ReturnType<AgentManager["buildModel"]>["model"];
}): ModelMessage[] => {
  return typeof addEphemeralCacheControlToLastMessage === "function"
    ? addEphemeralCacheControlToLastMessage(params)
    : fallbackAddEphemeralCacheControlToLastMessage(params);
};

export const buildAgentModelProfile = (params: {
  model: ReturnType<AgentManager["buildModel"]>["model"];
  providerOptions: ProviderOptions;
}): AgentModelProfile => {
  const profileModel = params.model;

  return {
    streamDefaults: {
      providerOptions: params.providerOptions,
    },
    prepareStep: ({ messages }) => ({
      messages: applyLastMessageCacheControl({
        messages,
        model: profileModel,
      }),
    }),
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
  _memoryExtractor?: BackgroundMemoryExtractor | null;
  private _memoryExtractorStorePath: string | null = null;
  private memoryStore: FileMemoryStore | null = null;
  private memoryStoreKey: string | null = null;
  private modelId: string = DEFAULT_MODEL_ID;
  private modelType: ModelType = "serverless";
  private provider: ProviderType = "anthropic";
  private headlessMode = false;
  private reasoningMode: ReasoningMode = DEFAULT_REASONING_MODE;
  private toolRegistry: ToolRegistry = defaultToolRegistry;
  private toolFallbackMode: ToolFallbackMode = DEFAULT_TOOL_FALLBACK_MODE;
  private translationEnabled = true;
  private readonly anthropicClient: ReturnType<typeof createAnthropic> | null;

  constructor(anthropicClient?: ReturnType<typeof createAnthropic> | null) {
    this.anthropicClient =
      anthropicClient !== undefined ? anthropicClient : anthropic;
    this.applyBestReasoningModeForCurrentModel();
  }

  resetForTesting(): void {
    this.modelId = DEFAULT_MODEL_ID;
    this.modelType = "serverless";
    this.provider = "anthropic";
    this.headlessMode = false;
    this.reasoningMode = DEFAULT_REASONING_MODE;
    this.toolRegistry = defaultToolRegistry;
    this.toolFallbackMode = DEFAULT_TOOL_FALLBACK_MODE;
    this.translationEnabled = true;
    this._memoryExtractor = null;
    this._memoryExtractorStorePath = null;
    this.memoryStore = null;
    this.memoryStoreKey = null;
    this.applyBestReasoningModeForCurrentModel();
  }

  setMemoryStore(store: FileMemoryStore | null, key: string | null): void {
    this.memoryStore = store;
    this.memoryStoreKey = key;
  }

  private applyBestReasoningModeForCurrentModel(): void {
    this.reasoningMode = selectBestReasoningMode(
      this.getSelectableReasoningModes()
    );
  }

  private getProviderModel(modelId: string) {
    if (!this.anthropicClient) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Please set it in your environment."
      );
    }

    return this.anthropicClient(modelId);
  }

  private buildModel(reasoningMode: ReasoningMode = this.reasoningMode) {
    const model = this.getProviderModel(this.modelId);
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

  private getContextLimitOverride(): number | null {
    return env.CONTEXT_LIMIT_OVERRIDE ?? null;
  }

  /**
   * Get the token limits for the currently selected model.
   * Used by compaction and context management systems.
   */
  getModelTokenLimits(): ModelTokenLimits {
    const contextLength =
      this.getContextLimitOverride() ?? getModelContextLength(this.modelId);

    return {
      contextLength,
      maxCompletionTokens: getModelMaxCompletionTokens(this.modelId),
    };
  }

  buildCompactionConfig(
    overrides?: Partial<CompactionConfig>
  ): CompactionConfig {
    const contextLength = getModelContextLength(this.modelId);
    const compactionReserveTokens = getCompactionReserveTokens(this.modelId);

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
      this.getProviderModel(this.modelId),
      {
        instructions: () => this.getInstructions(),
        contextLimit: effectiveContextLength,
        taskAwareCompaction: true,
      }
    );
    const { summarizeFn, getStructuredState: fileTrackingState } =
      buildFileTrackingSummarizeFn(baseModelSummarizer);

    const bmeDisabled = env.DISABLE_BME;
    if (bmeDisabled) {
      this._memoryExtractor = null;
      this._memoryExtractorStorePath = null;
    } else if (!(this.memoryStore && this.memoryStoreKey)) {
      this._memoryExtractor = null;
      this._memoryExtractorStorePath = null;
    } else if (
      this._memoryExtractor &&
      this._memoryExtractorStorePath === this.memoryStoreKey
    ) {
      this._memoryExtractor.updateModel(this.getProviderModel(this.modelId));
    } else {
      this._memoryExtractor = new BackgroundMemoryExtractor({
        model: this.getProviderModel(this.modelId),
        store: this.memoryStore,
        preset: "code",
      });
      this._memoryExtractorStorePath = this.memoryStoreKey;
    }
    const memoryExtractor = this._memoryExtractor;

    const getStructuredState = (): string | undefined => {
      const fileState = fileTrackingState();
      const memoryState = memoryExtractor?.getStructuredState();
      if (!(fileState || memoryState)) {
        return undefined;
      }
      const parts: string[] = [];
      if (memoryState) {
        parts.push(memoryState);
      }
      if (fileState) {
        parts.push(fileState);
      }
      return parts.join("\n\n");
    };

    const getLastExtractionMessageIndex = (): number | undefined => {
      if (!memoryExtractor?.getStructuredState()) {
        return undefined;
      }

      return memoryExtractor.getLastExtractionMessageIndex();
    };

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
      compactionDirection: "keep-recent" as const,
      contextLimit: effectiveContextLength,
      enabled: true,
      maxTokens,
      thresholdRatio,
      reserveTokens: effectiveReserveTokens,
      keepRecentTokens,
      microCompact: {
        clearToolResults: true,
        keepRecentToolResults: 5,
        clearOlderThanMs: 3_600_000,
      },
      speculativeStartRatio: computeSpeculativeStartRatio(
        effectiveContextLength,
        effectiveReserveTokens
      ),
      summarizeFn,
      getLastExtractionMessageIndex,
      getStructuredState,
      ...overrides,
    };
  }

  buildPruningConfig(overrides?: Partial<PruningConfig>): PruningConfig {
    return {
      ...createDefaultPruningConfig(),
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
    this.modelId = DEFAULT_ANTHROPIC_MODEL_ID;
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
    const modelProfile = buildAgentModelProfile({ model, providerOptions });

    // Use the smaller of caller's budget and provider cap.
    // Caller budget comes from harness context-window enforcement;
    // provider cap comes from model-specific limits.
    const effectiveMaxOutputTokens =
      options.maxOutputTokens != null
        ? Math.min(options.maxOutputTokens, providerMaxOutputTokens)
        : providerMaxOutputTokens;

    const instructions = await this.getInstructions();
    if (messages.length === 0) {
      throw new Error(
        "Cannot call the model with an empty message list after context preparation."
      );
    }

    const agent = await createAgent({
      model,
      tools: this.toolRegistry,
      instructions,
      maxStepsPerTurn: 1,
      experimental_repairToolCall: repairToolCall,
      ...mergeAgentModelProfile({ override: modelProfile }),
    });

    const result = agent.stream({
      messages,
      abortSignal: options.abortSignal,
      experimentalContext: options.experimentalContext,
      maxOutputTokens: effectiveMaxOutputTokens,
      providerOptions: options.providerOptions,
      seed: options.seed,
      system: options.system,
      temperature: options.temperature,
      ...getBenchmarkSamplingOverrides(),
    });

    return result;
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
    const preparedMessages = probeMessages;

    const agent = await createAgent({
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
 *   anthropicApiKey: 'test-token',
 *   anthropicBaseUrl: 'http://localhost:8080',
 * });
 * ```
 */
export function createAgentManager(options?: {
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
}): AgentManager {
  const anthropicApiKey = options?.anthropicApiKey ?? env.ANTHROPIC_API_KEY;
  const anthropicClient = anthropicApiKey
    ? createAnthropic({
        apiKey: anthropicApiKey,
        ...((options?.anthropicBaseUrl ?? env.ANTHROPIC_BASE_URL)
          ? { baseURL: options?.anthropicBaseUrl ?? env.ANTHROPIC_BASE_URL }
          : {}),
      })
    : null;

  return new AgentManager(anthropicClient);
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
