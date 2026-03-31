import { randomUUID } from "node:crypto";
import type { ModelMessage, TextPart } from "ai";
import { calculateCompactionSplitIndex } from "./compaction-planner";
import {
  getRecommendedMaxOutputTokens as getRecommendedMaxOutputTokensFromPolicy,
  isAtHardContextLimitFromUsage,
  needsCompactionFromUsage,
} from "./compaction-policy";
import type {
  ActualTokenUsage,
  ActualTokenUsageInput,
  CheckpointMessage,
  CompactionConfig,
  CompactionResult,
  ContextUsage,
  ContinuationVariant,
  MessageLine,
  PruningConfig,
} from "./compaction-types";
import { createContinuationMessage } from "./continuation";
import type { SessionStore } from "./session-store";
import {
  estimateMessageTokens,
  estimateTokens,
  extractMessageText,
} from "./token-utils";
import { progressivePrune, pruneToolOutputs } from "./tool-pruning";

const DEFAULT_COMPACTION_CONFIG: NormalizedCompactionConfig = {
  contextLimit: 0,
  enabled: false,
  getStructuredState: undefined,
  maxTokens: 8000,
  keepRecentTokens: 2000,
  reserveTokens: 2000,
  speculativeStartRatio: undefined,
  thresholdRatio: 0.5,
  summarizeFn: undefined,
};

const DEFAULT_PRUNING_CONFIG: Required<PruningConfig> = {
  eagerPruneToolNames: [],
  enabled: false,
  minSavingsTokens: 200,
  protectedToolNames: [],
  protectRecentTokens: 2000,
  replacementText: "[output pruned — too large]",
};

const TRAILING_NEWLINES = /\n+$/;

const COMPACTION_CONTINUATION_TEXTS = {
  "auto-with-replay":
    "Previous context was summarized above. The user's latest request follows — respond to it directly and naturally.",
  auto: "Context has been compacted. I'll continue working on the current task based on the summary.",
  manual:
    "The conversation was summarized above. Continue naturally without mentioning the summary or that compaction occurred.",
  "tool-loop":
    "Context was compacted mid-task. Resume your work and continue with any pending tool calls or steps.",
  overflow:
    "The context was compacted due to overflow. I'll resume the task from where we left off.",
} as const;

export function getContinuationText(
  variant: keyof typeof COMPACTION_CONTINUATION_TEXTS
): string {
  return COMPACTION_CONTINUATION_TEXTS[variant];
}

type NormalizedCompactionConfig = Omit<
  Required<CompactionConfig>,
  "getStructuredState" | "speculativeStartRatio" | "summarizeFn"
> &
  Pick<
    CompactionConfig,
    "getStructuredState" | "speculativeStartRatio" | "summarizeFn"
  >;

export interface CheckpointHistoryOptions {
  compaction?: CompactionConfig;
  pruning?: PruningConfig;
  sessionId?: string;
  sessionStore?: SessionStore;
}

export interface OverflowRecoveryResult {
  error?: string;
  strategy?: "prune" | "compact" | "aggressive-compact" | "truncate";
  success: boolean;
  tokensAfter: number;
  tokensBefore: number;
}

export function isContextOverflowError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const msg = error.message.toLowerCase();
  return (
    msg.includes("context_length_exceeded") ||
    msg.includes("context length exceeded") ||
    msg.includes("context window") ||
    msg.includes("maximum context") ||
    msg.includes("too many tokens") ||
    msg.includes("input is too long") ||
    msg.includes("prompt is too long") ||
    msg.includes("tokens exceeds") ||
    msg.includes("token limit")
  );
}

function hasToolCalls(message: ModelMessage): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return false;
  }

  return message.content.some(
    (part) =>
      typeof part === "object" && part !== null && part.type === "tool-call"
  );
}

function hasToolResults(message: ModelMessage): boolean {
  if (message.role !== "tool" || !Array.isArray(message.content)) {
    return false;
  }

  return message.content.some(
    (part) =>
      typeof part === "object" && part !== null && part.type === "tool-result"
  );
}

function getToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }

  return message.content.flatMap((part) => {
    if (
      typeof part === "object" &&
      part !== null &&
      part.type === "tool-call" &&
      typeof part.toolCallId === "string"
    ) {
      return [part.toolCallId];
    }
    return [];
  });
}

function getToolResultIds(message: ModelMessage): string[] {
  if (message.role !== "tool" || !Array.isArray(message.content)) {
    return [];
  }

  return message.content.flatMap((part) => {
    if (
      typeof part === "object" &&
      part !== null &&
      part.type === "tool-result" &&
      typeof part.toolCallId === "string"
    ) {
      return [part.toolCallId];
    }
    return [];
  });
}

function trimTrailingAssistantNewlines(message: ModelMessage): ModelMessage {
  if (message.role !== "assistant") {
    return message;
  }

  const content = message.content;
  if (typeof content === "string") {
    return {
      ...message,
      content: content.replace(TRAILING_NEWLINES, ""),
    };
  }

  if (!Array.isArray(content) || content.length === 0) {
    return message;
  }

  let lastTextIndex = -1;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index]?.type === "text") {
      lastTextIndex = index;
      break;
    }
  }

  if (lastTextIndex === -1) {
    return message;
  }

  const lastTextPart = content[lastTextIndex] as TextPart;
  const trimmedText = lastTextPart.text.replace(TRAILING_NEWLINES, "");
  if (trimmedText === lastTextPart.text) {
    return message;
  }

  const trimmedContent = [...content];
  trimmedContent[lastTextIndex] = {
    ...lastTextPart,
    text: trimmedText,
  };

  return {
    ...message,
    content: trimmedContent,
  };
}

function isReplayableTextOnlyUserMessage(message: CheckpointMessage): boolean {
  return (
    message.message.role === "user" &&
    typeof message.message.content === "string" &&
    message.message.content.trim().length > 0
  );
}

function findReplayableUserMessage(
  messages: CheckpointMessage[]
): CheckpointMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isReplayableTextOnlyUserMessage(message)) {
      return message;
    }
  }

  return null;
}

export class CheckpointHistory {
  private messages: CheckpointMessage[] = [];
  private summaryMessageId: string | null = null;
  private actualUsage: ActualTokenUsage | null = null;
  private recoveryInProgress = false;
  private contextLimit = 0;
  private systemPromptTokens = 0;
  private revision = 0;
  // message-only revision: bumped by add/compact/prune/truncate/clear, NOT metadata ops
  private messageRevision = 0;
  private readonly sessionId: string;
  private readonly sessionStore: SessionStore | null;
  private compactionConfig: NormalizedCompactionConfig;
  private pruningConfig: Required<PruningConfig>;

  constructor(options?: CheckpointHistoryOptions) {
    this.sessionId = options?.sessionId ?? randomUUID();
    this.sessionStore = options?.sessionStore ?? null;
    this.compactionConfig = {
      ...DEFAULT_COMPACTION_CONFIG,
      ...options?.compaction,
    };
    this.contextLimit = this.compactionConfig.contextLimit ?? 0;
    this.pruningConfig = {
      ...DEFAULT_PRUNING_CONFIG,
      ...options?.pruning,
    };
  }

  addUserMessage(content: string, originalContent?: string): CheckpointMessage {
    const message = this.createCheckpointMessage(
      {
        role: "user",
        content,
      },
      originalContent
    );

    this.messages.push(message);
    this.persistMessage(message);
    this.revision += 1;
    this.messageRevision += 1;

    return message;
  }

  addModelMessages(messages: ModelMessage[]): CheckpointMessage[] {
    const created = messages.map((message) =>
      this.createCheckpointMessage(message)
    );

    const nextMessages = this.ensureValidToolSequence([
      ...this.messages,
      ...created,
    ]);
    const createdIds = new Set(created.map((message) => message.id));
    const accepted = nextMessages.filter((message) =>
      createdIds.has(message.id)
    );

    this.messages = nextMessages;
    for (const message of accepted) {
      this.persistMessage(message);
    }

    if (accepted.length > 0) {
      this.revision += 1;
      this.messageRevision += 1;
    }
    return accepted;
  }

  getAll(): CheckpointMessage[] {
    return [...this.messages];
  }

  toModelMessages(): ModelMessage[] {
    return this.messages.map((message) => message.message);
  }

  getMessagesForLLM(): ModelMessage[] {
    const activeMessages = this.ensureValidToolSequence([
      ...this.getActiveMessages(),
    ]);

    return activeMessages.map((checkpointMessage) => {
      if (
        checkpointMessage.isSummaryMessage &&
        checkpointMessage.message.role === "assistant" &&
        typeof checkpointMessage.message.content === "string"
      ) {
        return {
          role: "user" as const,
          content: checkpointMessage.message.content,
        };
      }

      return checkpointMessage.message;
    });
  }

  getRevision(): number {
    return this.revision;
  }

  getMessageRevision(): number {
    return this.messageRevision;
  }

  clear(): void {
    this.messages = [];
    this.summaryMessageId = null;
    this.actualUsage = null;
    this.revision += 1;
    this.messageRevision += 1;
  }

  updateActualUsage(usage: ActualTokenUsageInput): void {
    const promptTokens =
      usage.promptTokens ?? usage.inputTokens ?? usage.totalTokens ?? 0;
    const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
    const totalTokens =
      usage.totalTokens ?? Math.max(0, promptTokens + completionTokens);

    this.actualUsage = {
      promptTokens,
      completionTokens,
      totalTokens,
      updatedAt: usage.updatedAt ?? new Date(),
    };
    this.revision += 1;
  }

  getActualUsage(): ActualTokenUsage | null {
    return this.actualUsage ? { ...this.actualUsage } : null;
  }

  getContextUsage(): ContextUsage {
    const limit = this.compactionConfig.contextLimit ?? 0;

    if (this.actualUsage) {
      const used = this.getCurrentUsageTokens();
      return {
        used,
        limit,
        remaining: limit > 0 ? Math.max(0, limit - used) : 0,
        percentage: limit > 0 ? Math.min(100, (used / limit) * 100) : 0,
        source: "actual",
      };
    }

    const estimated = this.getCurrentUsageTokens();
    return {
      used: estimated,
      limit,
      remaining: limit > 0 ? Math.max(0, limit - estimated) : 0,
      percentage: limit > 0 ? Math.min(100, (estimated / limit) * 100) : 0,
      source: "estimated",
    };
  }

  getSummaryMessageId(): string | null {
    return this.summaryMessageId;
  }

  getEstimatedTokens(): number {
    const activeMessages = this.getActiveMessages();

    return activeMessages.reduce(
      (total, checkpointMessage) =>
        total + estimateMessageTokens(checkpointMessage.message),
      0
    );
  }

  setContextLimit(limit: number): void {
    this.contextLimit = limit;
    this.compactionConfig = {
      ...this.compactionConfig,
      contextLimit: limit,
    };
    this.revision += 1;
  }

  getContextLimit(): number {
    return this.contextLimit;
  }

  setSystemPromptTokens(tokens: number): void {
    this.systemPromptTokens = tokens;
    this.revision += 1;
  }

  getSystemPromptTokens(): number {
    return this.systemPromptTokens;
  }

  isCompactionEnabled(): boolean {
    return this.compactionConfig.enabled ?? false;
  }

  isPruningEnabled(): boolean {
    return this.pruningConfig.enabled ?? false;
  }

  updateCompaction(config: Partial<CompactionConfig>): void {
    this.compactionConfig = {
      ...this.compactionConfig,
      ...config,
    };
    if (config.contextLimit !== undefined) {
      this.contextLimit = config.contextLimit;
    }
    this.revision += 1;
  }

  updatePruning(config: Partial<PruningConfig>): void {
    this.pruningConfig = {
      ...this.pruningConfig,
      ...config,
      protectedToolNames:
        config.protectedToolNames ?? this.pruningConfig.protectedToolNames,
    };
    this.revision += 1;
  }

  needsCompaction(): boolean {
    const contextLimit = this.getActiveContextLimit();
    const configuredThresholdRatio =
      this.compactionConfig.thresholdRatio ?? 0.5;
    const maxTokensRatio =
      typeof this.compactionConfig.maxTokens === "number" &&
      Number.isFinite(this.compactionConfig.maxTokens) &&
      this.compactionConfig.maxTokens > 0 &&
      contextLimit > 0
        ? this.compactionConfig.maxTokens / contextLimit
        : undefined;
    const thresholdRatio =
      typeof maxTokensRatio === "number"
        ? Math.min(configuredThresholdRatio, maxTokensRatio)
        : configuredThresholdRatio;

    return needsCompactionFromUsage({
      currentUsageTokens: this.getCurrentUsageTokens(),
      contextLimit,
      thresholdRatio,
      enabled: Boolean(this.compactionConfig.enabled),
      hasMessages: this.messages.length > 0,
    });
  }

  shouldStartSpeculativeCompactionForNextTurn(): boolean {
    const enabled = Boolean(
      this.compactionConfig.enabled || this.pruningConfig.enabled
    );
    if (!enabled || this.messages.length === 0) {
      return false;
    }

    const contextLimit = this.getActiveContextLimit();
    const currentUsage = this.getCurrentUsageTokens();

    const configuredThresholdRatio =
      this.compactionConfig.thresholdRatio ?? 0.5;
    const maxTokens = this.compactionConfig.maxTokens;
    const maxTokensRatio =
      typeof maxTokens === "number" &&
      Number.isFinite(maxTokens) &&
      maxTokens > 0 &&
      contextLimit > 0
        ? maxTokens / contextLimit
        : undefined;
    const blockingRatio =
      typeof maxTokensRatio === "number"
        ? Math.min(configuredThresholdRatio, maxTokensRatio)
        : configuredThresholdRatio;
    const blockingThreshold = contextLimit * blockingRatio;

    const speculativeStartRatio = this.compactionConfig.speculativeStartRatio;
    const speculativeFraction =
      typeof speculativeStartRatio === "number" &&
      Number.isFinite(speculativeStartRatio) &&
      speculativeStartRatio > 0 &&
      speculativeStartRatio < 1
        ? speculativeStartRatio
        : 0.75;
    const speculativeThreshold = blockingThreshold * speculativeFraction;

    const result = currentUsage >= speculativeThreshold;

    if (
      process.env.COMPACTION_DEBUG === "1" ||
      process.env.COMPACTION_DEBUG === "true"
    ) {
      console.error(
        `[compaction-debug] speculative? usage=${currentUsage} specThreshold=${Math.floor(speculativeThreshold)} blockThreshold=${Math.floor(blockingThreshold)} → ${result}`
      );
    }

    return result;
  }

  isAtHardContextLimit(
    additionalTokens = 0,
    options?: {
      phase: "new-turn" | "intermediate-step";
    }
  ): boolean {
    return isAtHardContextLimitFromUsage({
      additionalTokens,
      contextLimit: this.getActiveContextLimit(),
      currentUsageTokens: this.getCurrentUsageTokens(),
      enabled: Boolean(
        this.compactionConfig.enabled || this.pruningConfig.enabled
      ),
      reserveTokens: this.getEffectiveReserveTokens(options),
    });
  }

  getRecommendedMaxOutputTokens(messagesForLLM?: ModelMessage[]): number {
    const contextLimit = this.contextLimit;
    if (contextLimit <= 0) {
      return 8192;
    }

    let estimatedInputTokens = this.getCurrentUsageTokens();
    if (!this.actualUsage && messagesForLLM) {
      estimatedInputTokens =
        messagesForLLM.reduce(
          (total, message) => total + estimateMessageTokens(message),
          0
        ) + this.systemPromptTokens;
    }

    return (
      getRecommendedMaxOutputTokensFromPolicy({
        contextLimit,
        estimatedInputTokens,
        reserveTokens:
          this.compactionConfig.reserveTokens ??
          DEFAULT_COMPACTION_CONFIG.reserveTokens,
      }) ?? 0
    );
  }

  wouldExceedContextWithAdditionalMessage(
    content: string,
    options?: {
      phase: "new-turn" | "intermediate-step";
    }
  ): boolean {
    return this.isAtHardContextLimit(estimateTokens(content), options);
  }

  async compact(options?: {
    auto?: boolean;
    aggressive?: boolean;
    compactionTrigger?: "manual" | "auto" | "overflow";
  }): Promise<CompactionResult> {
    if (!this.compactionConfig.enabled) {
      return {
        success: false,
        tokensBefore: 0,
        tokensAfter: 0,
        reason: "compaction disabled",
      };
    }

    if (this.messages.length === 0) {
      return {
        success: false,
        tokensBefore: 0,
        tokensAfter: 0,
        reason: "no messages",
      };
    }

    const tokensBefore = this.getEstimatedTokens();
    const summaryIndex = this.summaryMessageId
      ? this.messages.findIndex(
          (message) => message.id === this.summaryMessageId
        )
      : 0;
    const activeStartIndex = summaryIndex === -1 ? 0 : summaryIndex;
    const activeMessages = this.messages.slice(activeStartIndex);

    const autoCompact = options?.auto === true;
    const hasExplicitAutoFlag = typeof options?.auto === "boolean";
    const replayMessage = autoCompact
      ? findReplayableUserMessage(activeMessages)
      : null;

    const splitIndex = hasExplicitAutoFlag
      ? activeMessages.length
      : this.resolveCompactionSplitIndex(
          activeMessages,
          options?.aggressive === true
        );

    if (splitIndex === null || splitIndex <= 0) {
      return {
        success: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        reason: "no messages to summarize",
      };
    }

    const toSummarizeCandidates = activeMessages.slice(0, splitIndex);
    const previousSummaryMessage =
      summaryIndex >= 0 ? this.messages[summaryIndex] : undefined;
    const previousSummary =
      previousSummaryMessage?.isSummary &&
      typeof previousSummaryMessage.message.content === "string"
        ? previousSummaryMessage.message.content
        : undefined;

    const toSummarize =
      previousSummary && toSummarizeCandidates[0]?.isSummary
        ? toSummarizeCandidates.slice(1)
        : toSummarizeCandidates;

    const toSummarizeForSummary = this.prePruneMessagesForSummary(toSummarize);

    if (toSummarizeForSummary.length === 0) {
      return {
        success: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        reason: "no messages to summarize",
      };
    }

    const summarizeFn = this.compactionConfig.summarizeFn;
    if (!summarizeFn) {
      return {
        success: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        reason: "no summarizeFn",
      };
    }

    const messageRevisionBeforeSummarize = this.messageRevision;

    const summaryText = await this.buildCompactionSummaryText({
      activeMessages,
      previousSummary,
      splitIndex,
      summarizeFn,
      toSummarizeForSummary,
    });

    if (!summaryText || summaryText.trim().length === 0) {
      return {
        success: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        reason: "empty summary",
      };
    }

    const messagesChangedDuringSummarize =
      this.messageRevision !== messageRevisionBeforeSummarize;

    const effectiveReplayMessage = messagesChangedDuringSummarize
      ? null
      : replayMessage;

    const summaryMessage: CheckpointMessage = {
      id: randomUUID(),
      createdAt: Date.now(),
      isSummary: true,
      isSummaryMessage: true,
      message: trimTrailingAssistantNewlines({
        role: "assistant",
        content: summaryText,
      }),
    };
    const continuationVariant = this.resolveContinuationVariant(
      autoCompact,
      effectiveReplayMessage
    );
    const continuationMessage: CheckpointMessage = {
      id: randomUUID(),
      createdAt: Date.now(),
      isSummary: false,
      isSummaryMessage: false,
      message: {
        role: "assistant",
        content: COMPACTION_CONTINUATION_TEXTS[continuationVariant],
      },
    };
    const replayMessageCopy = this.createReplayMessageCopy(
      effectiveReplayMessage
    );

    const insertIndex = activeStartIndex + splitIndex;
    this.messages.splice(insertIndex, 0, summaryMessage);
    this.messages.splice(insertIndex + 1, 0, continuationMessage);
    if (replayMessageCopy) {
      this.messages.push(replayMessageCopy);
    }

    this.summaryMessageId = summaryMessage.id;
    this.revision += 1;
    this.messageRevision += 1;

    await this.persistCompactionMessages({
      continuationMessage,
      replayMessageCopy,
      summaryMessage,
    });

    const tokensAfter = this.getEstimatedTokens();
    return {
      success: true,
      continuationVariant,
      summaryMessageId: summaryMessage.id,
      tokensBefore,
      tokensAfter,
    };
  }

  private prePruneMessagesForSummary(
    toSummarize: CheckpointMessage[]
  ): CheckpointMessage[] {
    const contextLimitForPrune =
      this.compactionConfig.contextLimit ?? this.getActiveContextLimit();
    const pruneTarget = Math.floor(contextLimitForPrune * 0.6);
    const estimatedSummarizeTokens = toSummarize.reduce(
      (sum, message) => sum + estimateMessageTokens(message.message),
      0
    );

    if (estimatedSummarizeTokens <= pruneTarget) {
      return toSummarize;
    }

    const pruneResult = progressivePrune(toSummarize, {
      enabled: true,
      protectRecentTokens: 40_000,
      targetTokens: pruneTarget,
    });

    if (pruneResult.tokensAfter < pruneResult.tokensBefore) {
      return pruneResult.messages;
    }

    return toSummarize;
  }

  async handleContextOverflow(
    _error?: unknown
  ): Promise<OverflowRecoveryResult> {
    if (this.recoveryInProgress) {
      const tokensBefore = this.getEstimatedTokens();
      return {
        success: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        error: "recovery in progress",
      };
    }

    const tokensBefore = this.getEstimatedTokens();

    if (!(this.compactionConfig.enabled || this.pruningConfig.enabled)) {
      return {
        success: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        error: "no reduction mechanism available",
      };
    }

    this.recoveryInProgress = true;
    try {
      const contextLimit = this.compactionConfig.contextLimit;

      const pruneResult = this.tryPruneRecovery(tokensBefore, contextLimit);
      if (pruneResult) {
        return pruneResult;
      }

      const compactResult = await this.compactForOverflowRecovery(
        false,
        tokensBefore,
        contextLimit
      );
      if (compactResult) {
        return compactResult;
      }

      const aggressiveResult = await this.compactForOverflowRecovery(
        true,
        tokensBefore,
        contextLimit
      );
      if (aggressiveResult) {
        return aggressiveResult;
      }

      const truncateResult = this.tryTruncateRecovery(
        tokensBefore,
        contextLimit
      );
      if (truncateResult) {
        return truncateResult;
      }

      const tokensAfter = this.getEstimatedTokens();
      return {
        success: false,
        tokensBefore,
        tokensAfter,
        error: `context overflow recovery exhausted all strategies (prune → compact → aggressive-compact → truncate). tokensBefore=${tokensBefore}, tokensAfter=${tokensAfter}, contextLimit=${contextLimit}`,
      };
    } finally {
      this.recoveryInProgress = false;
    }
  }

  getCompactionConfig(): Readonly<NormalizedCompactionConfig> {
    return { ...this.compactionConfig };
  }

  pruneMessages(targetTokens: number): Promise<{
    levelUsed: number;
    tokensAfter: number;
    tokensBefore: number;
  } | null> {
    if (!this.pruningConfig.enabled) {
      return Promise.resolve(null);
    }

    if (!Number.isFinite(targetTokens) || targetTokens < 0) {
      return Promise.resolve(null);
    }

    const activeMessages = this.getActiveMessages();
    if (activeMessages.length === 0) {
      return Promise.resolve(null);
    }

    const result = progressivePrune(activeMessages, {
      ...this.pruningConfig,
      enabled: true,
      targetTokens,
      protectRecentTokens: 40_000,
    });

    if (result.tokensAfter < result.tokensBefore) {
      this.applyPrunedMessages(result.messages);
    }

    return Promise.resolve({
      levelUsed: result.levelUsed,
      tokensAfter: result.tokensAfter,
      tokensBefore: result.tokensBefore,
    });
  }

  getPruningConfig(): Readonly<Required<PruningConfig>> {
    return {
      ...this.pruningConfig,
      protectedToolNames: [...this.pruningConfig.protectedToolNames],
    };
  }

  private resolveContinuationVariant(
    autoCompact: boolean,
    replayMessage: CheckpointMessage | null
  ): ContinuationVariant {
    if (!autoCompact) {
      return "manual";
    }

    return replayMessage ? "auto-with-replay" : "tool-loop";
  }

  private createReplayMessageCopy(
    replayMessage: CheckpointMessage | null
  ): CheckpointMessage | null {
    if (!replayMessage || typeof replayMessage.message.content !== "string") {
      return null;
    }

    return this.createCheckpointMessage(
      {
        role: "user",
        content: replayMessage.message.content,
      },
      replayMessage.originalContent
    );
  }

  private async persistCompactionMessages(params: {
    continuationMessage: CheckpointMessage;
    replayMessageCopy: CheckpointMessage | null;
    summaryMessage: CheckpointMessage;
  }): Promise<void> {
    if (!this.sessionStore) {
      return;
    }

    const { continuationMessage, replayMessageCopy, summaryMessage } = params;
    const summaryLine: MessageLine = {
      type: "message",
      id: summaryMessage.id,
      createdAt: summaryMessage.createdAt,
      isSummary: true,
      message: summaryMessage.message,
    };

    await this.sessionStore.appendMessage(this.sessionId, summaryLine);
    await this.sessionStore.appendMessage(this.sessionId, {
      type: "message",
      id: continuationMessage.id,
      createdAt: continuationMessage.createdAt,
      isSummary: continuationMessage.isSummary,
      originalContent: continuationMessage.originalContent,
      message: continuationMessage.message,
    });
    if (replayMessageCopy) {
      await this.sessionStore.appendMessage(this.sessionId, {
        type: "message",
        id: replayMessageCopy.id,
        createdAt: replayMessageCopy.createdAt,
        isSummary: replayMessageCopy.isSummary,
        originalContent: replayMessageCopy.originalContent,
        message: replayMessageCopy.message,
      });
    }

    await this.sessionStore.updateCheckpoint(this.sessionId, summaryMessage.id);
  }

  private getActiveMessages(): CheckpointMessage[] {
    if (!this.summaryMessageId) {
      return this.messages;
    }

    const summaryIndex = this.messages.findIndex(
      (message) => message.id === this.summaryMessageId
    );
    if (summaryIndex === -1) {
      console.warn(
        `[CheckpointHistory] summaryMessageId "${this.summaryMessageId}" not found, using full history`
      );
      return this.messages;
    }

    return this.messages.slice(summaryIndex);
  }

  private getCurrentUsageTokens(): number {
    if (this.actualUsage) {
      return this.actualUsage.promptTokens ?? this.actualUsage.totalTokens ?? 0;
    }
    return this.getEstimatedTokens() + this.systemPromptTokens;
  }

  private getActiveContextLimit(): number {
    if (this.contextLimit > 0) {
      return this.contextLimit;
    }

    return (
      this.compactionConfig.maxTokens ?? DEFAULT_COMPACTION_CONFIG.maxTokens
    );
  }

  private getEffectiveReserveTokens(options?: {
    phase?: "new-turn" | "intermediate-step";
  }): number {
    const reserveTokens =
      this.compactionConfig.reserveTokens ??
      DEFAULT_COMPACTION_CONFIG.reserveTokens;

    if (options?.phase === "intermediate-step") {
      if (this.actualUsage) {
        return reserveTokens;
      }
      return reserveTokens * 2;
    }

    return reserveTokens;
  }

  private resolveCompactionSplitIndex(
    activeMessages: CheckpointMessage[],
    forceAggressive: boolean
  ): number | null {
    if (forceAggressive) {
      return activeMessages.length - 1;
    }

    const defaultSplitIndex = calculateCompactionSplitIndex({
      adjustSplitIndex: (index) => index,
      aggressive: false,
      estimateMessageTokens: (message: CheckpointMessage) =>
        estimateTokens(extractMessageText(message.message)),
      keepRecentTokens: this.compactionConfig.keepRecentTokens ?? 2000,
      messages: activeMessages,
    });
    if (defaultSplitIndex !== null) {
      return defaultSplitIndex;
    }

    return calculateCompactionSplitIndex({
      adjustSplitIndex: (index) => index,
      aggressive: true,
      estimateMessageTokens: (message: CheckpointMessage) =>
        estimateTokens(extractMessageText(message.message)),
      keepRecentTokens: this.compactionConfig.keepRecentTokens ?? 2000,
      messages: activeMessages,
    });
  }

  private async buildCompactionSummaryText(params: {
    activeMessages: CheckpointMessage[];
    previousSummary?: string;
    splitIndex: number;
    summarizeFn: (
      messages: ModelMessage[],
      previousSummary?: string
    ) => Promise<string>;
    toSummarizeForSummary: CheckpointMessage[];
  }): Promise<string> {
    const {
      activeMessages,
      previousSummary,
      splitIndex,
      summarizeFn,
      toSummarizeForSummary,
    } = params;

    const splitTurnStart = this.findSplitTurnStartIndex({
      messagesToSummarize: toSummarizeForSummary,
      messagesAfterSplit: activeMessages.slice(splitIndex),
    });

    if (splitTurnStart === null) {
      return summarizeFn(
        toSummarizeForSummary.map((message) => message.message),
        previousSummary
      );
    }

    const reserveTokens =
      this.compactionConfig.reserveTokens ??
      DEFAULT_COMPACTION_CONFIG.reserveTokens;
    const historyReserveTokens = Math.floor(reserveTokens * 0.8);
    const turnPrefixReserveTokens = Math.floor(reserveTokens * 0.5);

    const historyMessages = toSummarizeForSummary.slice(0, splitTurnStart);
    const turnPrefixMessages = toSummarizeForSummary.slice(splitTurnStart);

    const historySummary =
      historyMessages.length > 0
        ? await this.summarizeWithReserveTokens(
            summarizeFn,
            historyMessages,
            historyReserveTokens,
            previousSummary
          )
        : (previousSummary ?? "");
    const turnPrefixSummary = await this.summarizeWithReserveTokens(
      summarizeFn,
      turnPrefixMessages,
      turnPrefixReserveTokens
    );

    return `${historySummary}\n\n---\n\n**Turn Context:**\n\n${turnPrefixSummary}`;
  }

  private findSplitTurnStartIndex(params: {
    messagesAfterSplit: CheckpointMessage[];
    messagesToSummarize: CheckpointMessage[];
  }): number | null {
    const { messagesToSummarize, messagesAfterSplit } = params;
    if (messagesToSummarize.length === 0 || messagesAfterSplit.length === 0) {
      return null;
    }

    const lastToSummarize = messagesToSummarize.at(-1);
    if (!(lastToSummarize && hasToolCalls(lastToSummarize.message))) {
      return null;
    }

    const toolCallIds = getToolCallIds(lastToSummarize.message);
    if (toolCallIds.length === 0) {
      return null;
    }

    const matchingResultAfterSplit = messagesAfterSplit.some((message) => {
      if (!hasToolResults(message.message)) {
        return false;
      }

      const resultIds = new Set(getToolResultIds(message.message));
      return toolCallIds.some((toolCallId) => resultIds.has(toolCallId));
    });

    if (!matchingResultAfterSplit) {
      return null;
    }

    let startIndex = messagesToSummarize.length - 1;
    while (startIndex >= 2) {
      const maybePreviousTool = messagesToSummarize[startIndex - 1];
      const maybePreviousCall = messagesToSummarize[startIndex - 2];
      if (
        maybePreviousTool?.message.role === "tool" &&
        hasToolResults(maybePreviousTool.message) &&
        maybePreviousCall &&
        hasToolCalls(maybePreviousCall.message)
      ) {
        startIndex -= 2;
        continue;
      }
      break;
    }

    return startIndex;
  }

  private async summarizeWithReserveTokens(
    summarizeFn: (
      messages: ModelMessage[],
      previousSummary?: string
    ) => Promise<string>,
    messages: CheckpointMessage[],
    reserveTokens: number,
    previousSummary?: string
  ): Promise<string> {
    const originalReserveTokens = this.compactionConfig.reserveTokens;
    this.compactionConfig = {
      ...this.compactionConfig,
      reserveTokens,
    };

    try {
      return await summarizeFn(
        messages.map((message) => message.message),
        previousSummary
      );
    } finally {
      this.compactionConfig = {
        ...this.compactionConfig,
        reserveTokens: originalReserveTokens,
      };
    }
  }

  private getRecoveryBudget(): number {
    const contextLimit = this.compactionConfig.contextLimit;
    if (contextLimit <= 0) {
      return 0; // unlimited — signal for "any reduction succeeds"
    }
    const reserveTokens =
      this.compactionConfig.reserveTokens ??
      DEFAULT_COMPACTION_CONFIG.reserveTokens;
    if (reserveTokens > 0) {
      const budget = contextLimit - reserveTokens;
      return budget > 0 ? budget : Math.floor(contextLimit * 0.95);
    }
    return Math.floor(contextLimit * 0.95);
  }

  private evaluateRecoveryAttempt(params: {
    contextLimit: number;
    tokensAfter: number;
    tokensBefore: number;
  }): boolean {
    const { contextLimit, tokensAfter, tokensBefore } = params;
    // Unlimited context: success = any reduction achieved
    if (contextLimit <= 0) {
      return tokensAfter < tokensBefore;
    }
    // Budget-based: must be under contextLimit (after reserve)
    const budget = this.getRecoveryBudget();
    return tokensAfter < budget;
  }

  private tryPruneRecovery(
    tokensBefore: number,
    contextLimit: number
  ): OverflowRecoveryResult | null {
    if (!this.pruningConfig.enabled) {
      return null;
    }

    const activeMessages = this.getActiveMessages();
    const pruneResult = pruneToolOutputs(activeMessages, this.pruningConfig);

    if (pruneResult.prunedCount === 0) {
      return null;
    }

    if (this.summaryMessageId) {
      const summaryIndex = this.messages.findIndex(
        (message) => message.id === this.summaryMessageId
      );
      if (summaryIndex !== -1) {
        this.messages = [
          ...this.messages.slice(0, summaryIndex),
          ...pruneResult.messages,
        ];
      } else {
        this.messages = pruneResult.messages;
      }
    } else {
      this.messages = pruneResult.messages;
    }
    this.revision += 1;
    this.messageRevision += 1;

    const tokensAfter = this.getEstimatedTokens();
    if (
      !this.evaluateRecoveryAttempt({
        contextLimit,
        tokensAfter,
        tokensBefore,
      })
    ) {
      return null;
    }

    return {
      success: true,
      strategy: "prune",
      tokensBefore,
      tokensAfter,
    };
  }

  private applyPrunedMessages(messages: CheckpointMessage[]): void {
    if (this.summaryMessageId) {
      const summaryIndex = this.messages.findIndex(
        (message) => message.id === this.summaryMessageId
      );
      if (summaryIndex !== -1) {
        this.messages = [...this.messages.slice(0, summaryIndex), ...messages];
      } else {
        this.messages = messages;
      }
    } else {
      this.messages = messages;
    }

    this.revision += 1;
    this.messageRevision += 1;
  }

  private async compactForOverflowRecovery(
    aggressive: boolean,
    tokensBefore: number,
    contextLimit: number
  ): Promise<OverflowRecoveryResult | null> {
    if (!(this.compactionConfig.enabled && this.compactionConfig.summarizeFn)) {
      return null;
    }

    const activeMessages = this.getActiveMessages();
    if (activeMessages.length <= 1) {
      return null;
    }

    const snapshot = {
      messages: [...this.messages],
      summaryMessageId: this.summaryMessageId,
      revision: this.revision,
      messageRevision: this.messageRevision,
    };

    let messagesToSummarize: CheckpointMessage[];
    let messagesToKeep: CheckpointMessage[];
    const replayMessage = findReplayableUserMessage(activeMessages);

    if (aggressive) {
      messagesToSummarize = activeMessages;
      messagesToKeep = [];
    } else {
      const splitIndex = this.resolveCompactionSplitIndex(
        activeMessages,
        false
      );
      if (splitIndex === null || splitIndex <= 0) {
        return null;
      }
      messagesToSummarize = activeMessages.slice(0, splitIndex);
      messagesToKeep = activeMessages.slice(splitIndex);
    }

    if (messagesToSummarize.length === 0) {
      return null;
    }

    let summaryText: string;
    try {
      summaryText = await this.compactionConfig.summarizeFn(
        messagesToSummarize.map((message) => message.message)
      );
    } catch {
      this.messages = snapshot.messages;
      this.summaryMessageId = snapshot.summaryMessageId;
      this.revision = snapshot.revision;
      this.messageRevision = snapshot.messageRevision;
      return null;
    }

    const summaryMessage: CheckpointMessage = {
      id: randomUUID(),
      createdAt: Date.now(),
      isSummary: true,
      isSummaryMessage: true,
      message: trimTrailingAssistantNewlines({
        role: "assistant",
        content: summaryText,
      }),
    };
    const continuationVariant = this.resolveContinuationVariant(
      true,
      replayMessage
    );
    const continuationMessage = this.createCheckpointMessage(
      createContinuationMessage(continuationVariant)
    );
    const replayMessageCopy = this.createReplayMessageCopy(replayMessage);

    let preActiveMessages: CheckpointMessage[] = [];
    if (this.summaryMessageId) {
      const summaryIdx = this.messages.findIndex(
        (message) => message.id === this.summaryMessageId
      );
      if (summaryIdx !== -1) {
        preActiveMessages = this.messages.slice(0, summaryIdx);
      }
    }

    this.messages = [
      ...preActiveMessages,
      summaryMessage,
      continuationMessage,
      ...messagesToKeep,
    ];
    if (replayMessageCopy) {
      this.messages.push(replayMessageCopy);
    }
    this.summaryMessageId = summaryMessage.id;
    this.revision += 1;
    this.messageRevision += 1;

    const tokensAfter = this.getEstimatedTokens();
    if (
      !this.evaluateRecoveryAttempt({
        contextLimit,
        tokensAfter,
        tokensBefore,
      })
    ) {
      this.messages = snapshot.messages;
      this.summaryMessageId = snapshot.summaryMessageId;
      this.revision = snapshot.revision;
      this.messageRevision = snapshot.messageRevision;
      return null;
    }

    if (this.sessionStore) {
      try {
        await this.sessionStore.updateCheckpoint(
          this.sessionId,
          summaryMessage.id
        );
      } catch (_error) {
        await Promise.resolve();
      }
    }

    return {
      success: true,
      strategy: aggressive ? "aggressive-compact" : "compact",
      tokensBefore,
      tokensAfter,
    };
  }

  private tryTruncateRecovery(
    tokensBefore: number,
    contextLimit: number
  ): OverflowRecoveryResult | null {
    if (contextLimit <= 0) {
      return null;
    }

    while (
      this.getEstimatedTokens() >= contextLimit &&
      this.messages.length > 1
    ) {
      const oldestNonSummaryIdx = this.messages.findIndex(
        (message) => !message.isSummary
      );
      if (oldestNonSummaryIdx === -1) {
        break;
      }
      this.messages.splice(oldestNonSummaryIdx, 1);
      this.revision += 1;
      this.messageRevision += 1;
    }

    while (
      this.getEstimatedTokens() >= contextLimit &&
      this.messages.length > 1
    ) {
      this.messages.splice(0, 1);
      this.revision += 1;
      this.messageRevision += 1;
      const newSummary = this.messages.find((m) => m.isSummary);
      this.summaryMessageId = newSummary?.id ?? null;
    }

    if (this.getEstimatedTokens() >= contextLimit) {
      const lastUserMessage = [...this.messages]
        .reverse()
        .find((message) => message.message.role === "user");
      const fallbackMessage = lastUserMessage ?? this.messages.at(-1);
      if (!fallbackMessage) {
        return null;
      }
      this.messages = [fallbackMessage];
      this.summaryMessageId = null;
      this.revision += 1;
      this.messageRevision += 1;
    }

    const tokensAfter = this.getEstimatedTokens();

    if (tokensAfter >= contextLimit) {
      return {
        success: false,
        strategy: undefined,
        tokensBefore,
        tokensAfter,
        error: "context window too small for remaining content",
      };
    }

    if (
      !this.evaluateRecoveryAttempt({
        contextLimit,
        tokensAfter,
        tokensBefore,
      })
    ) {
      return null;
    }

    return {
      success: true,
      strategy: "truncate",
      tokensBefore,
      tokensAfter,
    };
  }

  private createCheckpointMessage(
    message: ModelMessage,
    originalContent?: string
  ): CheckpointMessage {
    return {
      id: randomUUID(),
      createdAt: Date.now(),
      isSummary: false,
      isSummaryMessage: false,
      originalContent,
      message: trimTrailingAssistantNewlines(message),
    };
  }

  private persistMessage(message: CheckpointMessage): void {
    if (!this.sessionStore) {
      return;
    }

    const line: MessageLine = {
      type: "message",
      id: message.id,
      createdAt: message.createdAt,
      isSummary: message.isSummary,
      originalContent: message.originalContent,
      message: message.message,
    };

    this.sessionStore
      .appendMessage(this.sessionId, line)
      .catch(() => undefined);
  }

  private ensureValidToolSequence(
    messages: CheckpointMessage[]
  ): CheckpointMessage[] {
    while (messages.length > 0 && messages[0]?.message.role === "tool") {
      messages.shift();
    }

    let index = 1;
    while (index < messages.length) {
      const current = messages[index];
      if (current?.message.role === "tool") {
        const previous = messages[index - 1];
        if (!(previous && hasToolCalls(previous.message))) {
          messages.splice(index, 1);
          continue;
        }
      }
      index += 1;
    }

    index = 0;
    while (index < messages.length) {
      const current = messages[index];
      if (current && hasToolCalls(current.message)) {
        const nextIndex = index + 1;
        const next = messages[nextIndex];
        if (!next || next.message.role !== "tool") {
          messages.splice(index, 1);
          continue;
        }
      }
      index += 1;
    }

    return messages;
  }
}
