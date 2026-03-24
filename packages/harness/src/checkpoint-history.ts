import { randomUUID } from "node:crypto";
import type { ModelMessage, TextPart } from "ai";
import { calculateCompactionSplitIndex } from "./compaction-planner";
import {
  getRecommendedMaxOutputTokens as getRecommendedMaxOutputTokensFromPolicy,
  isAtHardContextLimitFromUsage,
  needsCompactionFromUsage,
  shouldStartSpeculativeCompaction,
} from "./compaction-policy";
import type {
  ActualTokenUsage,
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
import { estimateTokens, extractMessageText } from "./token-utils";
import { pruneToolOutputs } from "./tool-pruning";

const DEFAULT_COMPACTION_CONFIG: NormalizedCompactionConfig = {
  contextLimit: 0,
  enabled: false,
  maxTokens: 8000,
  keepRecentTokens: 2000,
  reserveTokens: 2000,
  speculativeStartRatio: undefined,
  summarizeFn: undefined,
};

const DEFAULT_PRUNING_CONFIG: Required<PruningConfig> = {
  enabled: false,
  minSavingsTokens: 200,
  protectedToolNames: [],
  protectRecentTokens: 2000,
  replacementText: "[output pruned — too large]",
};

const TRAILING_NEWLINES = /\n+$/;

type NormalizedCompactionConfig = Omit<
  Required<CompactionConfig>,
  "speculativeStartRatio" | "summarizeFn"
> &
  Pick<CompactionConfig, "speculativeStartRatio" | "summarizeFn">;

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

    this.revision += 1;
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

    if (!this.summaryMessageId) {
      return activeMessages.map((message) => message.message);
    }

    const summaryIndex = this.messages.findIndex(
      (message) => message.id === this.summaryMessageId
    );
    if (summaryIndex === -1) {
      return activeMessages.map((message) => message.message);
    }

    return activeMessages.map((checkpointMessage, index) => {
      if (
        index === 0 &&
        checkpointMessage.isSummary &&
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

  clear(): void {
    this.messages = [];
    this.summaryMessageId = null;
    this.actualUsage = null;
    this.revision += 1;
  }

  updateActualUsage(usage: ActualTokenUsage): void {
    this.actualUsage = {
      ...usage,
      updatedAt: new Date(),
    };
    this.revision += 1;
  }

  getActualUsage(): ActualTokenUsage | null {
    return this.actualUsage ? { ...this.actualUsage } : null;
  }

  getContextUsage(): ContextUsage {
    const limit = this.compactionConfig.contextLimit ?? 0;

    if (this.actualUsage) {
      const used =
        this.actualUsage.promptTokens ?? this.actualUsage.totalTokens ?? 0;
      return {
        used,
        limit,
        remaining: limit > 0 ? Math.max(0, limit - used) : 0,
        percentage: limit > 0 ? Math.min(100, (used / limit) * 100) : 0,
        source: "actual",
      };
    }

    const estimated = this.getEstimatedTokens();
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
        total + estimateTokens(extractMessageText(checkpointMessage.message)),
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

  needsCompaction(options?: {
    phase?: "new-turn" | "intermediate-step";
  }): boolean {
    const reserveTokens = this.getEffectiveReserveTokens(options);
    const thresholdLimit =
      this.actualUsage && this.contextLimit > 0
        ? this.contextLimit - reserveTokens
        : (this.compactionConfig.maxTokens ??
            DEFAULT_COMPACTION_CONFIG.maxTokens) - reserveTokens;

    return needsCompactionFromUsage({
      currentUsageTokens:
        this.actualUsage && this.contextLimit > 0
          ? (this.actualUsage.totalTokens ?? this.getEstimatedTokens())
          : this.getEstimatedTokens(),
      enabled: Boolean(this.compactionConfig.enabled),
      hasMessages: this.messages.length > 0,
      thresholdLimit,
    });
  }

  shouldStartSpeculativeCompactionForNextTurn(): boolean {
    const speculativeLimit = Math.min(
      this.getActiveContextLimit(),
      this.compactionConfig.maxTokens ?? Number.POSITIVE_INFINITY
    );

    return shouldStartSpeculativeCompaction({
      contextLimit: speculativeLimit,
      input: {
        currentUsageTokens: this.getCurrentUsageTokens(),
        enabled: Boolean(
          this.compactionConfig.enabled || this.pruningConfig.enabled
        ),
        hasMessages: this.messages.length > 0,
        phaseReserveTokens: this.getEffectiveReserveTokens({
          phase: "new-turn",
        }),
        speculativeStartRatio: this.compactionConfig.speculativeStartRatio,
      },
    });
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

    const estimatedInputTokens =
      (messagesForLLM
        ? messagesForLLM.reduce(
            (total, message) =>
              total + estimateTokens(extractMessageText(message)),
            0
          )
        : this.getCurrentUsageTokens()) + this.systemPromptTokens;

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

    const toSummarizeForSummary = replayMessage
      ? toSummarize.filter((message) => message.id !== replayMessage.id)
      : toSummarize;

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

    const summaryText = await summarizeFn(
      toSummarizeForSummary.map((message) => message.message),
      previousSummary
    );

    if (!summaryText || summaryText.trim().length === 0) {
      return {
        success: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        reason: "empty summary",
      };
    }

    const summaryMessage: CheckpointMessage = {
      id: randomUUID(),
      createdAt: Date.now(),
      isSummary: true,
      message: trimTrailingAssistantNewlines({
        role: "assistant",
        content: summaryText,
      }),
    };
    const continuationVariant = this.resolveContinuationVariant(
      autoCompact,
      replayMessage
    );
    const continuationMessage = this.createCheckpointMessage(
      createContinuationMessage(continuationVariant)
    );
    const replayMessageCopy = this.createReplayMessageCopy(replayMessage);

    const insertIndex = activeStartIndex + splitIndex;
    this.messages.splice(insertIndex, 0, summaryMessage);
    this.messages.splice(insertIndex + 1, 0, continuationMessage);
    if (replayMessageCopy) {
      this.messages.push(replayMessageCopy);
    }

    this.summaryMessageId = summaryMessage.id;
    this.revision += 1;

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
        this.actualUsage = null;
        return pruneResult;
      }

      const compactResult = await this.compactForOverflowRecovery(
        false,
        tokensBefore,
        contextLimit
      );
      if (compactResult) {
        this.actualUsage = null;
        return compactResult;
      }

      const aggressiveResult = await this.compactForOverflowRecovery(
        true,
        tokensBefore,
        contextLimit
      );
      if (aggressiveResult) {
        this.actualUsage = null;
        return aggressiveResult;
      }

      const truncateResult = this.tryTruncateRecovery(
        tokensBefore,
        contextLimit
      );
      if (truncateResult) {
        if (truncateResult.success) {
          this.actualUsage = null;
        }
        return truncateResult;
      }

      const tokensAfter = this.getEstimatedTokens();
      throw new Error(
        `Context overflow recovery exhausted all strategies (prune → compact → aggressive-compact → truncate). tokensBefore=${tokensBefore}, tokensAfter=${tokensAfter}, contextLimit=${contextLimit}`
      );
    } finally {
      this.recoveryInProgress = false;
    }
  }

  getCompactionConfig(): Readonly<NormalizedCompactionConfig> {
    return { ...this.compactionConfig };
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
    return this.actualUsage?.totalTokens ?? this.getEstimatedTokens();
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

  private getRecoveryBudget(): number {
    const contextLimit = this.compactionConfig.contextLimit;
    if (contextLimit <= 0) {
      return 0; // unlimited — signal for "any reduction succeeds"
    }
    const reserveTokens =
      this.compactionConfig.reserveTokens ??
      DEFAULT_COMPACTION_CONFIG.reserveTokens;
    // Use 5% reserve if reserveTokens is 0
    return reserveTokens > 0
      ? contextLimit - reserveTokens
      : Math.floor(contextLimit * 0.95);
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
    };

    let messagesToSummarize: CheckpointMessage[];
    let messagesToKeep: CheckpointMessage[];

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
      return null;
    }

    const summaryMessage: CheckpointMessage = {
      id: randomUUID(),
      createdAt: Date.now(),
      isSummary: true,
      message: { role: "assistant", content: summaryText },
    };

    const preActiveMessages = this.summaryMessageId
      ? this.messages.slice(
          0,
          this.messages.findIndex(
            (message) => message.id === this.summaryMessageId
          )
        )
      : [];

    this.messages = [...preActiveMessages, summaryMessage, ...messagesToKeep];
    this.summaryMessageId = summaryMessage.id;
    this.revision += 1;

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
    }

    while (
      this.getEstimatedTokens() >= contextLimit &&
      this.messages.length > 1
    ) {
      this.messages.splice(0, 1);
      this.revision += 1;
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
