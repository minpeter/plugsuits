import { randomUUID } from "node:crypto";
import type { ModelMessage, TextPart } from "ai";
import { calculateCompactionSplitIndex } from "./compaction-planner";
import {
  computeContextBudget,
  getRecommendedMaxOutputTokens as getRecommendedMaxOutputTokensFromPolicy,
  isAtHardContextLimitFromUsage,
  needsCompactionFromUsage,
} from "./compaction-policy";
import type {
  ActualTokenUsage,
  ActualTokenUsageInput,
  CheckpointMessage,
  CompactionConfig,
  CompactionEffectiveness,
  CompactionRejectionReason,
  CompactionResult,
  ContextUsage,
  ContinuationVariant,
  MessageLine,
  PruningConfig,
} from "./compaction-types";
import {
  DEFAULT_MIN_SAVINGS_RATIO,
  INEFFECTIVE_COMPACTION_REASON,
} from "./compaction-types";
import { collapseConsecutiveOps } from "./context-collapse";
import { createContinuationMessage, getContinuationText } from "./continuation";
import { env } from "./env";
import {
  deserializeMessage,
  type HistorySnapshot,
  serializeMessage,
} from "./history-snapshot";
import { microCompactMessages } from "./micro-compact";
import type { SnapshotStore } from "./snapshot-store";
import {
  estimateMessageTokens,
  estimateTokens,
  extractMessageText,
} from "./token-utils";
import { adjustSplitIndexForToolPairs } from "./tool-pair-validation";
import { progressivePrune, pruneToolOutputs } from "./tool-pruning";

const TOOL_RESULT_CHARS_PER_TOKEN_INTERNAL = 6;

const DEFAULT_COMPACTION_CONFIG: NormalizedCompactionConfig = {
  compactionDirection: "keep-recent",
  contextLimit: 0,
  contextCollapse: true,
  enabled: false,
  getLastExtractionMessageIndex: undefined,
  getStructuredState: undefined,
  microCompact: undefined,
  maxTokens: 8000,
  keepRecentTokens: 2000,
  reserveTokens: 2000,
  sessionMemoryCompaction: undefined,
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

const COMPACTION_CONTINUATION_TEXT_SET: ReadonlySet<string> = new Set([
  getContinuationText("auto-with-replay"),
  getContinuationText("auto"),
  getContinuationText("manual"),
  getContinuationText("tool-loop"),
  getContinuationText("overflow"),
]);

function computeSavingsRatio(
  savedTokens: number,
  tokensBefore: number
): number {
  if (tokensBefore > 0) {
    return savedTokens / tokensBefore;
  }
  return savedTokens > 0 ? 1 : 0;
}

function validateCompactionConfig(config: NormalizedCompactionConfig): void {
  if (config.enabled && !config.summarizeFn) {
    console.warn(
      "compaction enabled without summarizeFn — will use naive truncation"
    );
  }
  if (config.contextLimit === 0 && config.enabled) {
    console.warn("contextLimit is 0, compaction may not work correctly");
  }
}

type CompactionDirection = "keep-recent" | "keep-prefix";

type NormalizedCompactionConfig = Omit<
  Required<CompactionConfig>,
  | "getStructuredState"
  | "getLastExtractionMessageIndex"
  | "microCompact"
  | "sessionMemoryCompaction"
  | "speculativeStartRatio"
  | "summarizeFn"
> &
  Pick<
    CompactionConfig,
    | "getStructuredState"
    | "getLastExtractionMessageIndex"
    | "microCompact"
    | "sessionMemoryCompaction"
    | "speculativeStartRatio"
    | "summarizeFn"
  >;

export interface CheckpointHistoryOptions {
  compaction?: CompactionConfig;
  pruning?: PruningConfig;
  sessionId?: string;
}

export interface OverflowRecoveryResult {
  error?: string;
  strategy?: "prune" | "compact" | "aggressive-compact" | "truncate";
  success: boolean;
  tokensAfter: number;
  tokensBefore: number;
}

export { isContextOverflowError } from "./overflow-detection";

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

function hasTextContent(message: CheckpointMessage): boolean {
  const content = message.message.content;

  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return content.some(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0
  );
}

export class CheckpointHistory {
  private messages: CheckpointMessage[] = [];
  private summaryMessageId: string | null = null;
  private actualUsage: ActualTokenUsage | null = null;
  private recoveryInProgress = false;
  private contextLimit = 0;
  private systemPromptTokens = 0;
  private toolSchemasTokens = 0;
  private revision = 0;
  // message-only revision: bumped by add/compact/prune/truncate/clear, NOT metadata ops
  private messageRevision = 0;
  private compactionConfig: NormalizedCompactionConfig;
  private pruningConfig: Required<PruningConfig>;

  constructor(options?: CheckpointHistoryOptions) {
    this.compactionConfig = {
      ...DEFAULT_COMPACTION_CONFIG,
      ...options?.compaction,
    };
    validateCompactionConfig(this.compactionConfig);
    this.contextLimit = this.compactionConfig.contextLimit ?? 0;
    this.pruningConfig = {
      ...DEFAULT_PRUNING_CONFIG,
      ...options?.pruning,
    };
  }

  static async fromSnapshot(
    store: SnapshotStore,
    sessionId: string,
    options?: CheckpointHistoryOptions
  ): Promise<CheckpointHistory> {
    const history = new CheckpointHistory({
      ...options,
      sessionId,
    });
    const snapshot = await store.load(sessionId);
    if (snapshot) {
      history.restoreFromSnapshot(snapshot);
    }
    return history;
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
    this.refreshEstimatedUsage();
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

    if (accepted.length > 0) {
      this.refreshEstimatedUsage();
      this.revision += 1;
      this.messageRevision += 1;
      this.truncateToolResultsIfOverBudget();
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

  snapshot(): HistorySnapshot {
    const actualUsage = this.getActualUsage();

    return {
      messages: this.getAll().map(serializeMessage),
      revision: this.revision,
      contextLimit: this.contextLimit,
      systemPromptTokens: this.systemPromptTokens,
      toolSchemasTokens: this.toolSchemasTokens,
      compactionState: {
        summaryMessageId: this.getSummaryMessageId(),
      },
      compactionConfig: {
        enabled: this.compactionConfig.enabled,
        contextLimit: this.compactionConfig.contextLimit,
        keepRecentTokens: this.compactionConfig.keepRecentTokens,
        reserveTokens: this.compactionConfig.reserveTokens,
        maxTokens: this.compactionConfig.maxTokens,
        thresholdRatio: this.compactionConfig.thresholdRatio,
        speculativeStartRatio: this.compactionConfig.speculativeStartRatio,
      },
      pruningConfig: {
        enabled: this.pruningConfig.enabled,
        eagerPruneToolNames: [...this.pruningConfig.eagerPruneToolNames],
      },
      ...(actualUsage
        ? {
            actualUsage: {
              inputTokens: actualUsage.inputTokens,
              outputTokens: actualUsage.outputTokens,
              totalTokens: actualUsage.totalTokens,
            },
          }
        : {}),
    };
  }

  getMessageRevision(): number {
    return this.messageRevision;
  }

  restoreFromSnapshot(snapshot: HistorySnapshot): void {
    this.messages = [];
    this.summaryMessageId = null;
    this.actualUsage = null;
    this.revision = 0;
    this.messageRevision = 0;

    if (snapshot.compactionConfig) {
      this.updateCompaction(snapshot.compactionConfig);
    }

    if (snapshot.pruningConfig) {
      this.updatePruning(snapshot.pruningConfig);
    }

    this.hydrateMessages(
      snapshot.messages.map((serializedMessage) => {
        const message = deserializeMessage(serializedMessage);

        return {
          type: "message" as const,
          id: message.id,
          createdAt: message.createdAt,
          isSummary: message.isSummary,
          originalContent: message.originalContent,
          message: message.message,
        };
      })
    );

    this.setContextLimit(snapshot.contextLimit);
    this.setSystemPromptTokens(snapshot.systemPromptTokens);
    this.setToolSchemasTokens(snapshot.toolSchemasTokens);

    const summaryMessageId = snapshot.compactionState?.summaryMessageId ?? null;
    this.summaryMessageId =
      summaryMessageId &&
      this.messages.some((message) => message.id === summaryMessageId)
        ? summaryMessageId
        : null;

    if (snapshot.actualUsage?.inputTokens !== undefined) {
      const outputTokens = snapshot.actualUsage.outputTokens ?? 0;
      this.actualUsage = {
        inputTokens: snapshot.actualUsage.inputTokens,
        outputTokens,
        totalTokens:
          snapshot.actualUsage.totalTokens ??
          snapshot.actualUsage.inputTokens + outputTokens,
        updatedAt: new Date(),
      };
    }

    this.revision = snapshot.revision;
  }

  clear(): void {
    this.messages = [];
    this.summaryMessageId = null;
    this.refreshEstimatedUsage();
    this.revision += 1;
    this.messageRevision += 1;
  }

  resetForSession(_sessionId: string): void {
    this.clear();
    this.actualUsage = null;
  }

  updateActualUsage(usage: ActualTokenUsageInput): void {
    const inputTokens = usage.inputTokens;

    if (inputTokens === undefined) {
      if (env.COMPACTION_DEBUG) {
        console.error(
          `[compaction-debug] updateActualUsage: no inputTokens in usage data, skipping (received keys: ${Object.keys(usage).join(", ")})`
        );
      }
      return;
    }

    const outputTokens = usage.outputTokens ?? 0;
    const totalTokens =
      usage.totalTokens ?? Math.max(0, inputTokens + outputTokens);

    this.actualUsage = {
      inputTokens,
      outputTokens,
      totalTokens,
      updatedAt: usage.updatedAt ?? new Date(),
    };
    this.revision += 1;
    this.truncateToolResultsIfOverBudget();
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
    const prev = this.systemPromptTokens;
    this.systemPromptTokens = tokens;
    if (prev !== tokens && this.actualUsage) {
      this.actualUsage = null;
    }
    this.revision += 1;
  }

  getSystemPromptTokens(): number {
    return this.systemPromptTokens;
  }

  setToolSchemasTokens(tokens: number): void {
    const prev = this.toolSchemasTokens;
    this.toolSchemasTokens = tokens;
    if (prev !== tokens && this.actualUsage) {
      this.actualUsage = null;
    }
    this.revision += 1;
  }

  getToolSchemasTokens(): number {
    return this.toolSchemasTokens;
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
    const contextLimit = this.getCompactionPolicyContextLimit();
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

    const contextLimit = this.getCompactionPolicyContextLimit();
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

    if (env.COMPACTION_DEBUG) {
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
        ) +
        this.systemPromptTokens +
        this.toolSchemasTokens;
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

    const tokensBefore =
      this.getEstimatedTokens() +
      this.systemPromptTokens +
      this.toolSchemasTokens;
    const summaryIndex = this.summaryMessageId
      ? this.messages.findIndex(
          (message) => message.id === this.summaryMessageId
        )
      : 0;
    const activeStartIndex = summaryIndex === -1 ? 0 : summaryIndex;
    const activeMessages = this.messages.slice(activeStartIndex);

    const autoCompact = options?.auto === true;
    const hasExplicitAutoFlag = typeof options?.auto === "boolean";
    const compactionDirection = this.resolveCompactionDirection();
    const replayMessage = autoCompact
      ? findReplayableUserMessage(activeMessages)
      : null;

    const splitIndex = hasExplicitAutoFlag
      ? activeMessages.length
      : this.resolveCompactionSplitIndex(
          activeMessages,
          options?.aggressive === true,
          compactionDirection
        );

    if (!this.isValidCompactionSplitIndex(splitIndex)) {
      return {
        success: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        reason: "no messages to summarize",
      };
    }

    const previousSummary = this.resolvePreviousSummary(summaryIndex);

    const messageRevisionBeforeSummarize = this.messageRevision;
    let summaryText: string;
    let compactionMethod: CompactionResult["compactionMethod"];
    let summaryInsertSplitIndex = splitIndex;
    const sessionMemorySummary = this.buildSessionMemoryCompactionSummary(
      activeMessages,
      activeStartIndex
    );

    if (sessionMemorySummary) {
      summaryText = sessionMemorySummary.summary;
      summaryInsertSplitIndex = sessionMemorySummary.keepFromIndex;
      compactionMethod = "session-memory";
    } else {
      const toSummarizeCandidates = this.selectMessagesToSummarize(
        activeMessages,
        splitIndex,
        compactionDirection
      );
      const toSummarize =
        previousSummary && toSummarizeCandidates[0]?.isSummary
          ? toSummarizeCandidates.slice(1)
          : toSummarizeCandidates;
      const toSummarizeForSummary =
        this.prePruneMessagesForSummary(toSummarize);
      const toSummarizeForCompaction = this.applyMicroCompactionForSummary(
        toSummarizeForSummary
      );

      if (toSummarizeForCompaction.length === 0) {
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

      summaryText = await this.buildCompactionSummaryText({
        activeMessages,
        compactionDirection,
        previousSummary,
        splitIndex,
        summarizeFn,
        toSummarizeForSummary: toSummarizeForCompaction,
      });
      compactionMethod = "llm";
      this.logCompactionDebug("compact summary method=llm");
    }

    if (this.isEmptyCompactionSummary(summaryText)) {
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
        content: getContinuationText(continuationVariant),
      },
    };
    const replayMessageCopy = this.createReplayMessageCopy(
      effectiveReplayMessage
    );

    const preInstallSnapshot = {
      messages: [...this.messages],
      summaryMessageId: this.summaryMessageId,
      revision: this.revision,
      messageRevision: this.messageRevision,
      actualUsage: this.actualUsage,
    };

    const insertIndex = activeStartIndex + summaryInsertSplitIndex;
    this.messages.splice(insertIndex, 0, summaryMessage);
    this.messages.splice(insertIndex + 1, 0, continuationMessage);
    this.insertReplayMessage(
      replayMessageCopy,
      compactionDirection,
      insertIndex + 2
    );

    this.summaryMessageId = summaryMessage.id;
    this.refreshEstimatedUsage();
    this.revision += 1;
    this.messageRevision += 1;

    const tokensAfter =
      this.getEstimatedTokens() +
      this.systemPromptTokens +
      this.toolSchemasTokens;
    const effectiveness = this.evaluateCompactionAcceptance({
      contextLimit: this.compactionConfig.contextLimit,
      tokensAfter,
      tokensBefore,
    });

    const rejection = this.maybeRejectCompaction({
      autoCompact,
      compactionMethod,
      effectiveness,
      snapshot: preInstallSnapshot,
      tokensAfter,
      tokensBefore,
    });
    if (rejection) {
      return rejection;
    }

    return {
      success: true,
      compactionMethod,
      continuationVariant,
      effectiveness,
      summaryMessageId: summaryMessage.id,
      tokensBefore,
      tokensAfter,
    };
  }

  private appendReplayMessage(
    replayMessageCopy: CheckpointMessage | null
  ): void {
    if (replayMessageCopy) {
      this.messages.push(replayMessageCopy);
    }
  }

  private insertReplayMessage(
    replayMessageCopy: CheckpointMessage | null,
    direction: CompactionDirection,
    insertIndex: number
  ): void {
    if (!replayMessageCopy) {
      return;
    }

    if (direction === "keep-prefix") {
      this.messages.splice(insertIndex, 0, replayMessageCopy);
      return;
    }

    this.appendReplayMessage(replayMessageCopy);
  }

  private selectMessagesToSummarize(
    activeMessages: CheckpointMessage[],
    splitIndex: number,
    direction: CompactionDirection
  ): CheckpointMessage[] {
    if (direction === "keep-prefix") {
      return activeMessages.slice(splitIndex);
    }

    return activeMessages.slice(0, splitIndex);
  }

  private isValidCompactionSplitIndex(
    splitIndex: number | null
  ): splitIndex is number {
    return splitIndex !== null && splitIndex > 0;
  }

  private isEmptyCompactionSummary(summaryText: string): boolean {
    return summaryText.trim().length === 0;
  }

  private resolvePreviousSummary(summaryIndex: number): string | undefined {
    if (summaryIndex < 0) {
      return undefined;
    }

    const previousSummaryMessage = this.messages[summaryIndex];
    if (
      previousSummaryMessage?.isSummary &&
      typeof previousSummaryMessage.message.content === "string"
    ) {
      return previousSummaryMessage.message.content;
    }

    return undefined;
  }

  private buildSessionMemoryCompactionSummary(
    messages: CheckpointMessage[],
    activeStartIndex: number
  ): { keepFromIndex: number; summary: string } | undefined {
    const structuredState = this.compactionConfig
      .getStructuredState?.()
      ?.trim();
    if (!structuredState) {
      this.logCompactionDebug(
        "compact summary fallback=llm reason=structured-state-empty"
      );
      return undefined;
    }

    const estimatedStateTokens = estimateTokens(structuredState);
    const contextLimit = this.getContextLimit();
    const sessionMemoryThreshold = contextLimit * 0.3;

    if (estimatedStateTokens >= sessionMemoryThreshold) {
      this.logCompactionDebug(
        `compact summary fallback=llm reason=structured-state-too-large structuredStateTokens=${estimatedStateTokens} threshold=${Math.floor(sessionMemoryThreshold)} contextLimit=${contextLimit}`
      );
      return undefined;
    }

    const sessionMemoryCompactionConfig =
      this.compactionConfig.sessionMemoryCompaction ?? {};
    const minKeepTokens = Math.max(
      0,
      Math.floor(sessionMemoryCompactionConfig.minKeepTokens ?? 2000)
    );
    const minKeepMessages = Math.max(
      0,
      Math.floor(sessionMemoryCompactionConfig.minKeepMessages ?? 3)
    );
    const maxKeepTokens = Math.max(
      0,
      Math.floor(
        sessionMemoryCompactionConfig.maxKeepTokens ?? contextLimit * 0.4
      )
    );

    const keepWindow = this.resolveSessionMemoryKeepWindow(messages, {
      maxKeepTokens,
      minKeepMessages,
      minKeepTokens,
    });
    let keepFromIndex = keepWindow.keepFromIndex;

    const coveredUntilIndex = this.resolveSessionMemoryCoveredIndex(
      activeStartIndex,
      messages.length
    );
    if (coveredUntilIndex !== undefined) {
      keepFromIndex = Math.min(keepFromIndex, coveredUntilIndex);
    }

    const adjustedKeepFromIndex = adjustSplitIndexForToolPairs(
      messages,
      keepFromIndex
    );
    if (adjustedKeepFromIndex <= 0 && coveredUntilIndex !== undefined) {
      this.logCompactionDebug(
        `compact summary fallback=llm reason=session-memory-keep-window-empty keepFromIndex=${adjustedKeepFromIndex} coveredUntilIndex=${coveredUntilIndex ?? "none"}`
      );
      return undefined;
    }

    this.logCompactionDebug(
      `compact summary method=session-memory structuredStateTokens=${estimatedStateTokens} threshold=${Math.floor(sessionMemoryThreshold)} contextLimit=${contextLimit} keepFromIndex=${adjustedKeepFromIndex} keptTokens=${keepWindow.keptTokens} keptTextMessages=${keepWindow.keptTextMessages} coveredUntilIndex=${coveredUntilIndex ?? "none"}`
    );

    return {
      summary: `[Session Memory Summary]\n\n${structuredState}`,
      keepFromIndex: adjustedKeepFromIndex,
    };
  }

  private resolveSessionMemoryCoveredIndex(
    activeStartIndex: number,
    activeMessageCount: number
  ): number | undefined {
    const absoluteCoveredIndex =
      this.compactionConfig.getLastExtractionMessageIndex?.();
    if (
      absoluteCoveredIndex === undefined ||
      !Number.isFinite(absoluteCoveredIndex)
    ) {
      return undefined;
    }

    const normalizedAbsoluteIndex = Math.max(
      0,
      Math.floor(absoluteCoveredIndex)
    );
    const relativeCoveredIndex = normalizedAbsoluteIndex - activeStartIndex;

    return Math.max(0, Math.min(activeMessageCount, relativeCoveredIndex));
  }

  private resolveSessionMemoryKeepWindow(
    messages: CheckpointMessage[],
    options: {
      maxKeepTokens: number;
      minKeepMessages: number;
      minKeepTokens: number;
    }
  ): { keepFromIndex: number; keptTextMessages: number; keptTokens: number } {
    const { maxKeepTokens, minKeepMessages, minKeepTokens } = options;
    let keepFromIndex = messages.length;
    let keptTokens = 0;
    let keptTextMessages = 0;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message) {
        continue;
      }

      const messageTokens = estimateMessageTokens(message.message);
      if (keptTokens + messageTokens > maxKeepTokens) {
        break;
      }

      keepFromIndex = i;
      keptTokens += messageTokens;
      if (hasTextContent(message)) {
        keptTextMessages += 1;
      }

      if (keptTokens >= minKeepTokens && keptTextMessages >= minKeepMessages) {
        break;
      }
    }

    return {
      keepFromIndex,
      keptTokens,
      keptTextMessages,
    };
  }

  private logCompactionDebug(message: string): void {
    if (env.COMPACTION_DEBUG) {
      console.error(`[compaction-debug] ${message}`);
    }
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

  private applyMicroCompactionForSummary(
    messagesToSummarize: CheckpointMessage[]
  ): CheckpointMessage[] {
    let preparedMessages = messagesToSummarize;

    if (this.compactionConfig.contextCollapse !== false) {
      const collapsed = collapseConsecutiveOps(preparedMessages);
      preparedMessages = collapsed.messages;
    }

    const microCompactSetting = this.compactionConfig.microCompact;
    const shouldRunMicroCompact =
      microCompactSetting === true ||
      (typeof microCompactSetting === "object" && microCompactSetting !== null);

    if (!shouldRunMicroCompact) {
      return preparedMessages;
    }

    const result = microCompactMessages(
      preparedMessages,
      typeof microCompactSetting === "object" && microCompactSetting !== null
        ? microCompactSetting
        : undefined
    );

    if (env.COMPACTION_DEBUG) {
      console.error(
        `[compaction-debug] microCompact: modified=${result.messagesModified}, tokensSaved=${result.tokensSaved}`
      );
    }

    return result.messages;
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

  getActiveMessages(): CheckpointMessage[] {
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

    if (this.resolveCompactionDirection() === "keep-prefix") {
      let endExclusive = summaryIndex + 1;
      const continuationCandidate = this.messages[endExclusive];
      if (this.isCompactionContinuationMessage(continuationCandidate)) {
        endExclusive += 1;
      }

      const replayCandidate = this.messages[endExclusive];
      if (replayCandidate && isReplayableTextOnlyUserMessage(replayCandidate)) {
        endExclusive += 1;
      }

      return this.messages.slice(0, endExclusive);
    }

    return this.messages.slice(summaryIndex);
  }

  private getActiveStartIndex(): number {
    if (!this.summaryMessageId) {
      return 0;
    }

    const summaryIndex = this.messages.findIndex(
      (message) => message.id === this.summaryMessageId
    );

    if (summaryIndex === -1) {
      return 0;
    }

    if (this.resolveCompactionDirection() === "keep-prefix") {
      return 0;
    }

    return summaryIndex;
  }

  private isCompactionContinuationMessage(
    message: CheckpointMessage | undefined
  ): boolean {
    if (
      !message ||
      message.message.role !== "assistant" ||
      typeof message.message.content !== "string"
    ) {
      return false;
    }

    return COMPACTION_CONTINUATION_TEXT_SET.has(message.message.content);
  }

  private resolveCompactionDirection(): CompactionDirection {
    return this.compactionConfig.compactionDirection === "keep-prefix"
      ? "keep-prefix"
      : "keep-recent";
  }

  private refreshEstimatedUsage(): void {
    const estimated =
      this.getEstimatedTokens() +
      this.systemPromptTokens +
      this.toolSchemasTokens;
    this.actualUsage = {
      inputTokens: estimated,
      outputTokens: 0,
      totalTokens: estimated,
      updatedAt: new Date(),
    };
  }

  private truncateToolResultsIfOverBudget(): void {
    const contextLimit = this.getActiveContextLimit();
    if (contextLimit <= 0) {
      return;
    }

    const reserveTokens = this.compactionConfig.reserveTokens ?? 0;
    const hardCeiling = Math.max(
      Math.floor(contextLimit * 0.9),
      contextLimit - reserveTokens
    );
    const currentTokens = this.getCurrentUsageTokens();

    if (currentTokens <= hardCeiling) {
      return;
    }

    const entries = this.collectToolResultEntries();
    entries.sort((a, b) => b.tokens - a.tokens);

    let remaining = currentTokens;
    for (const entry of entries) {
      if (remaining <= hardCeiling) {
        break;
      }
      remaining = this.truncateSingleToolResult(entry, remaining, hardCeiling);
    }

    if (remaining !== currentTokens) {
      this.refreshEstimatedUsage();
    }
  }

  private collectToolResultEntries(): Array<{
    messageIndex: number;
    partIndex: number;
    tokens: number;
  }> {
    const entries: Array<{
      messageIndex: number;
      partIndex: number;
      tokens: number;
    }> = [];

    // Only iterate over active messages so we don't waste truncation budget
    // on pre-summary messages that don't contribute to active context tokens.
    const startIndex = this.getActiveStartIndex();
    for (let mi = startIndex; mi < this.messages.length; mi++) {
      const content = this.messages[mi].message.content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (let pi = 0; pi < content.length; pi++) {
        const part = content[pi];
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "tool-result"
        ) {
          const output = (part as { output?: unknown }).output;
          // Use inner field text when available, consistent with truncateSingleToolResult.
          // This ensures charsToFree math operates on the same text basis as the token estimate.
          const innerFieldText = this.extractInnerFieldText(output);
          const text =
            innerFieldText ??
            (typeof output === "string"
              ? output
              : JSON.stringify(output ?? ""));
          entries.push({
            messageIndex: mi,
            partIndex: pi,
            tokens: Math.ceil(
              text.length / TOOL_RESULT_CHARS_PER_TOKEN_INTERNAL
            ),
          });
        }
      }
    }
    return entries;
  }

  private truncateSingleToolResult(
    entry: { messageIndex: number; partIndex: number; tokens: number },
    currentTokens: number,
    hardCeiling: number
  ): number {
    const message = this.messages[entry.messageIndex];
    const content = message.message.content;
    if (!Array.isArray(content)) {
      return currentTokens;
    }
    const originalPart = content[entry.partIndex] as {
      type: string;
      output?: unknown;
    };
    const originalOutput = originalPart.output;

    // For object outputs with .value/.text, use the inner field for truncation math
    // so that charsToFree targets the actual truncatable content, not the JSON wrapper.
    const innerFieldText = this.extractInnerFieldText(originalOutput);
    const originalText =
      innerFieldText ??
      (typeof originalOutput === "string"
        ? originalOutput
        : JSON.stringify(originalOutput ?? ""));
    const tokensToFree = currentTokens - hardCeiling;
    const charsToFree = tokensToFree * TOOL_RESULT_CHARS_PER_TOKEN_INTERNAL;

    let truncatedText: string;
    if (originalText.length <= charsToFree) {
      truncatedText = `[truncated: ${entry.tokens} tokens freed for context budget]`;
    } else {
      const keepChars = Math.max(200, originalText.length - charsToFree);
      truncatedText =
        originalText.slice(0, keepChars) +
        `\n... [truncated ${originalText.length - keepChars} chars for context budget]`;
    }

    // Shallow-clone the truncated part and its parent message/content array.
    // NOTE: Only the truncated part at entry.partIndex is cloned — other parts
    // in the same content array remain shared references with prior snapshots.
    const clonedPart = { ...originalPart };

    if (typeof originalOutput === "string") {
      (clonedPart as Record<string, unknown>).output = truncatedText;
    } else if (typeof originalOutput === "object" && originalOutput !== null) {
      const clonedOutput = { ...(originalOutput as Record<string, unknown>) };
      if (typeof clonedOutput.value === "string") {
        clonedOutput.value = truncatedText;
        (clonedPart as Record<string, unknown>).output = clonedOutput;
      } else if (typeof clonedOutput.text === "string") {
        clonedOutput.text = truncatedText;
        (clonedPart as Record<string, unknown>).output = clonedOutput;
      } else {
        // No recognized inner field — replace the entire output
        (clonedPart as Record<string, unknown>).output = truncatedText;
      }
    } else {
      (clonedPart as Record<string, unknown>).output = truncatedText;
    }

    const clonedContent = content.slice() as typeof content;
    clonedContent[entry.partIndex] = clonedPart as (typeof content)[number];
    this.messages[entry.messageIndex] = {
      ...message,
      message: {
        ...message.message,
        content: clonedContent,
      } as typeof message.message,
    };

    // Compute new token count using the same logic as collectToolResultEntries:
    // extract inner field text first, fall back to JSON.stringify.
    const finalOutput = (clonedPart as Record<string, unknown>).output;
    const finalInnerText = this.extractInnerFieldText(finalOutput);
    const finalText =
      finalInnerText ??
      (typeof finalOutput === "string"
        ? finalOutput
        : JSON.stringify(finalOutput ?? ""));
    const newTokens = Math.ceil(
      finalText.length / TOOL_RESULT_CHARS_PER_TOKEN_INTERNAL
    );
    return currentTokens - (entry.tokens - newTokens);
  }

  private extractInnerFieldText(output: unknown): string | null {
    if (typeof output !== "object" || output === null) {
      return null;
    }
    const obj = output as Record<string, unknown>;
    if (typeof obj.value === "string") {
      return obj.value;
    }
    if (typeof obj.text === "string") {
      return obj.text;
    }
    return null;
  }

  private getCurrentUsageTokens(): number {
    if (this.actualUsage) {
      return this.actualUsage.inputTokens;
    }
    return (
      this.getEstimatedTokens() +
      this.systemPromptTokens +
      this.toolSchemasTokens
    );
  }

  private getActiveContextLimit(): number {
    if (this.contextLimit > 0) {
      return this.contextLimit;
    }

    return (
      this.compactionConfig.maxTokens ?? DEFAULT_COMPACTION_CONFIG.maxTokens
    );
  }

  private getCompactionPolicyContextLimit(): number {
    const rawContextLimit = this.getActiveContextLimit();
    if (rawContextLimit <= 0) {
      return rawContextLimit;
    }

    const budget = computeContextBudget({
      contextLimit: rawContextLimit,
      maxOutputTokens: this.compactionConfig.maxTokens,
      reserveTokens: this.compactionConfig.reserveTokens,
      thresholdRatio: this.compactionConfig.thresholdRatio,
    });

    return Math.max(1, budget.effectiveContextWindow);
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
    forceAggressive: boolean,
    direction: CompactionDirection
  ): number | null {
    if (direction === "keep-prefix") {
      return this.resolveKeepPrefixSplitIndex(activeMessages, forceAggressive);
    }

    if (forceAggressive) {
      const splitIndex = this.adjustSplitIndexToApiRoundBoundary(
        activeMessages,
        activeMessages.length - 1
      );
      const adjustedSplitIndex = adjustSplitIndexForToolPairs(
        activeMessages,
        splitIndex
      );

      return adjustedSplitIndex > 0 ? adjustedSplitIndex : null;
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
      const splitIndex = this.adjustSplitIndexToApiRoundBoundary(
        activeMessages,
        defaultSplitIndex
      );
      const adjustedSplitIndex = adjustSplitIndexForToolPairs(
        activeMessages,
        splitIndex
      );

      return adjustedSplitIndex > 0 ? adjustedSplitIndex : null;
    }

    const aggressiveSplitIndex = calculateCompactionSplitIndex({
      adjustSplitIndex: (index) => index,
      aggressive: true,
      estimateMessageTokens: (message: CheckpointMessage) =>
        estimateTokens(extractMessageText(message.message)),
      keepRecentTokens: this.compactionConfig.keepRecentTokens ?? 2000,
      messages: activeMessages,
    });

    if (aggressiveSplitIndex === null) {
      return null;
    }

    const splitIndex = this.adjustSplitIndexToApiRoundBoundary(
      activeMessages,
      aggressiveSplitIndex
    );
    const adjustedSplitIndex = adjustSplitIndexForToolPairs(
      activeMessages,
      splitIndex
    );

    return adjustedSplitIndex > 0 ? adjustedSplitIndex : null;
  }

  private adjustSplitIndexToApiRoundBoundary(
    activeMessages: CheckpointMessage[],
    rawSplitIndex: number
  ): number {
    const messageCount = activeMessages.length;
    if (
      messageCount === 0 ||
      rawSplitIndex <= 0 ||
      rawSplitIndex > messageCount
    ) {
      return rawSplitIndex;
    }

    const maxShiftDistance = messageCount * 0.2;
    let nearestBoundaryIndex: number | null = null;
    let nearestBoundaryDistance = Number.POSITIVE_INFINITY;

    for (let i = 1; i < messageCount; i += 1) {
      const previousMessage = activeMessages[i - 1];
      const currentMessage = activeMessages[i];

      if (!(previousMessage && currentMessage)) {
        continue;
      }

      if (
        previousMessage.message.role !== "assistant" ||
        currentMessage.message.role !== "user"
      ) {
        continue;
      }

      const distance = Math.abs(rawSplitIndex - i);
      if (distance < nearestBoundaryDistance) {
        nearestBoundaryDistance = distance;
        nearestBoundaryIndex = i;
      }
    }

    if (
      nearestBoundaryIndex === null ||
      !(nearestBoundaryDistance < maxShiftDistance)
    ) {
      return rawSplitIndex;
    }

    return nearestBoundaryIndex;
  }

  private resolveKeepPrefixSplitIndex(
    activeMessages: CheckpointMessage[],
    forceAggressive: boolean
  ): number | null {
    if (activeMessages.length <= 1) {
      return null;
    }

    if (forceAggressive) {
      const splitIndex = this.adjustSplitIndexToApiRoundBoundary(
        activeMessages,
        1
      );
      const adjustedSplitIndex = adjustSplitIndexForToolPairs(
        activeMessages,
        splitIndex
      );

      return adjustedSplitIndex > 0 ? adjustedSplitIndex : null;
    }

    const keepPrefixTokens = this.compactionConfig.keepRecentTokens ?? 2000;
    let keptTokens = 0;
    let splitIndex = activeMessages.length;

    for (let i = 0; i < activeMessages.length; i += 1) {
      const message = activeMessages[i];
      if (!message) {
        continue;
      }

      const messageTokens = estimateTokens(extractMessageText(message.message));
      if (keptTokens + messageTokens > keepPrefixTokens) {
        splitIndex = i;
        break;
      }

      keptTokens += messageTokens;
      if (i === activeMessages.length - 1) {
        splitIndex = activeMessages.length;
      }
    }

    if (splitIndex >= activeMessages.length) {
      return null;
    }

    if (splitIndex <= 0) {
      const adjustedToBoundary = this.adjustSplitIndexToApiRoundBoundary(
        activeMessages,
        1
      );
      const adjustedSplitIndex = adjustSplitIndexForToolPairs(
        activeMessages,
        adjustedToBoundary
      );
      return adjustedSplitIndex > 0 ? adjustedSplitIndex : null;
    }

    const adjustedToBoundary = this.adjustSplitIndexToApiRoundBoundary(
      activeMessages,
      splitIndex
    );
    const adjustedSplitIndex = adjustSplitIndexForToolPairs(
      activeMessages,
      adjustedToBoundary
    );

    return adjustedSplitIndex > 0 ? adjustedSplitIndex : null;
  }

  private async buildCompactionSummaryText(params: {
    activeMessages: CheckpointMessage[];
    compactionDirection: CompactionDirection;
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
      compactionDirection,
      previousSummary,
      splitIndex,
      summarizeFn,
      toSummarizeForSummary,
    } = params;

    if (compactionDirection === "keep-prefix") {
      return summarizeFn(
        toSummarizeForSummary.map((message) => message.message),
        previousSummary
      );
    }

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

  private evaluateCompactionAcceptance(params: {
    contextLimit: number;
    minSavingsRatio?: number;
    tokensAfter: number;
    tokensBefore: number;
  }): CompactionEffectiveness {
    const {
      contextLimit,
      minSavingsRatio = DEFAULT_MIN_SAVINGS_RATIO,
      tokensAfter,
      tokensBefore,
    } = params;

    const savedTokens = tokensBefore - tokensAfter;
    const savingsRatio = computeSavingsRatio(savedTokens, tokensBefore);

    // Unlimited context: any reduction counts as fitting and below-threshold;
    // only require minimum savings to reject degenerate summaries.
    if (contextLimit <= 0) {
      const meetsMinSavings = savingsRatio >= minSavingsRatio;
      return {
        belowTriggerThreshold: savedTokens > 0,
        fitsBudget: savedTokens > 0,
        meetsMinSavings,
        savedTokens,
        savingsRatio,
        triggerThresholdTokens: 0,
      };
    }

    const budget = this.getRecoveryBudget();
    const thresholdRatio =
      this.compactionConfig.thresholdRatio ??
      DEFAULT_COMPACTION_CONFIG.thresholdRatio;
    const triggerThresholdTokens = Math.floor(contextLimit * thresholdRatio);

    const fitsBudget = tokensAfter < budget;
    const belowTriggerThreshold = tokensAfter < triggerThresholdTokens;
    const meetsMinSavings = savingsRatio >= minSavingsRatio;

    return {
      belowTriggerThreshold,
      fitsBudget,
      meetsMinSavings,
      savedTokens,
      savingsRatio,
      triggerThresholdTokens,
    };
  }

  private resolveRejectionReason(
    effectiveness: CompactionEffectiveness
  ): CompactionRejectionReason | null {
    if (!effectiveness.fitsBudget) {
      return "exceeds-budget";
    }
    // belowTriggerThreshold and meetsMinSavings are observability signals only.
    // Rejecting on those causes false negatives with real LLM summaries that
    // land just above the trigger ratio, leading to emergency blocking
    // compaction when tokens eventually hit the hard limit. The per-turn cap
    // in the orchestrator prevents degenerate retry loops.
    return null;
  }

  private isCompactionAccepted(
    effectiveness: CompactionEffectiveness
  ): boolean {
    return this.resolveRejectionReason(effectiveness) === null;
  }

  private isAutoCompactWarranted(tokensBefore: number): boolean {
    const contextLimit = this.compactionConfig.contextLimit;
    if (contextLimit <= 0) {
      return false;
    }

    const thresholdRatio =
      this.compactionConfig.thresholdRatio ??
      DEFAULT_COMPACTION_CONFIG.thresholdRatio;
    const triggerTokens = Math.floor(contextLimit * thresholdRatio);
    return tokensBefore >= triggerTokens;
  }

  private maybeRejectCompaction(params: {
    autoCompact: boolean;
    compactionMethod: CompactionResult["compactionMethod"];
    effectiveness: CompactionEffectiveness;
    snapshot: {
      actualUsage: ActualTokenUsage | null;
      messages: CheckpointMessage[];
      messageRevision: number;
      revision: number;
      summaryMessageId: string | null;
    };
    tokensAfter: number;
    tokensBefore: number;
  }): CompactionResult | null {
    if (!params.autoCompact) {
      return null;
    }

    // Gate only applies when compaction was actually warranted. If the
    // pre-compaction token count is still below the auto-compact trigger, the
    // caller is force-compacting at a tiny scale (tests, warm-up, etc.) and
    // the gate would produce false rejections because overhead dominates.
    if (!this.isAutoCompactWarranted(params.tokensBefore)) {
      return null;
    }

    const rejectionReason = this.resolveRejectionReason(params.effectiveness);
    if (!rejectionReason) {
      return null;
    }

    this.messages = params.snapshot.messages;
    this.summaryMessageId = params.snapshot.summaryMessageId;
    this.actualUsage = params.snapshot.actualUsage;
    this.revision = params.snapshot.revision;
    this.messageRevision = params.snapshot.messageRevision;
    this.refreshEstimatedUsage();

    this.logCompactionDebug(
      `compact rejected: ${rejectionReason} (saved=${params.effectiveness.savedTokens}, ratio=${params.effectiveness.savingsRatio.toFixed(3)})`
    );

    return {
      success: false,
      compactionMethod: params.compactionMethod,
      effectiveness: params.effectiveness,
      reason: INEFFECTIVE_COMPACTION_REASON,
      rejectionReason,
      tokensAfter: params.tokensAfter,
      tokensBefore: params.tokensBefore,
    };
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
    this.refreshEstimatedUsage();
    this.revision += 1;
    this.messageRevision += 1;

    const tokensAfter =
      this.getEstimatedTokens() +
      this.systemPromptTokens +
      this.toolSchemasTokens;
    const pruneEffectiveness = this.evaluateCompactionAcceptance({
      contextLimit,
      tokensAfter,
      tokensBefore,
    });
    if (!pruneEffectiveness.fitsBudget) {
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
      actualUsage: this.actualUsage,
    };

    const compactionDirection = this.resolveCompactionDirection();
    const replayMessage = findReplayableUserMessage(activeMessages);

    const overflowSplit = this.resolveOverflowCompactionSegments(
      activeMessages,
      aggressive,
      compactionDirection
    );
    if (!overflowSplit) {
      return null;
    }

    const { messagesToKeep, messagesToSummarize } = overflowSplit;

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
      this.actualUsage = snapshot.actualUsage;
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
    this.refreshEstimatedUsage();
    this.revision += 1;
    this.messageRevision += 1;

    const tokensAfter =
      this.getEstimatedTokens() +
      this.systemPromptTokens +
      this.toolSchemasTokens;
    const effectiveness = this.evaluateCompactionAcceptance({
      contextLimit,
      tokensAfter,
      tokensBefore,
    });
    // Aggressive overflow recovery is a last-resort strategy; only require that
    // the result fits within the recovery budget. Non-aggressive overflow must
    // pass the full acceptance gate to avoid pathological re-compaction loops.
    const accepted = aggressive
      ? effectiveness.fitsBudget
      : this.isCompactionAccepted(effectiveness);
    if (!accepted) {
      this.messages = snapshot.messages;
      this.summaryMessageId = snapshot.summaryMessageId;
      this.actualUsage = snapshot.actualUsage;
      this.revision = snapshot.revision;
      this.messageRevision = snapshot.messageRevision;
      return null;
    }

    return {
      success: true,
      strategy: aggressive ? "aggressive-compact" : "compact",
      tokensBefore,
      tokensAfter,
    };
  }

  private resolveOverflowCompactionSegments(
    activeMessages: CheckpointMessage[],
    aggressive: boolean,
    direction: CompactionDirection
  ): {
    messagesToKeep: CheckpointMessage[];
    messagesToSummarize: CheckpointMessage[];
  } | null {
    if (aggressive) {
      return {
        messagesToSummarize: activeMessages,
        messagesToKeep: [],
      };
    }

    const splitIndex = this.resolveCompactionSplitIndex(
      activeMessages,
      false,
      direction
    );

    if (splitIndex === null || splitIndex <= 0) {
      return null;
    }

    if (direction === "keep-prefix") {
      return {
        messagesToSummarize: activeMessages.slice(splitIndex),
        messagesToKeep: activeMessages.slice(0, splitIndex),
      };
    }

    return {
      messagesToSummarize: activeMessages.slice(0, splitIndex),
      messagesToKeep: activeMessages.slice(splitIndex),
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

    this.refreshEstimatedUsage();
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

    const truncateEffectiveness = this.evaluateCompactionAcceptance({
      contextLimit,
      tokensAfter,
      tokensBefore,
    });
    if (!truncateEffectiveness.fitsBudget) {
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

  private hydrateMessages(lines: MessageLine[]): void {
    const hydrated = lines.map((line) => ({
      id: line.id,
      createdAt: line.createdAt,
      isSummary: line.isSummary,
      isSummaryMessage: line.isSummary,
      originalContent: line.originalContent,
      message: trimTrailingAssistantNewlines(line.message),
    }));

    this.messages = this.ensureValidToolSequence(hydrated);
    this.refreshEstimatedUsage();
    this.revision += 1;
    this.messageRevision += 1;
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
