import type { ModelMessage, TextPart, ToolResultPart } from "ai";
import type { PruningConfig } from "./tool-pruning";
import { pruneToolOutputs } from "./tool-pruning";

const TRAILING_NEWLINES = /\n+$/;

// Constants for token estimation and compaction
const LATIN_CHARS_PER_TOKEN = 4;
const CJK_CHARS_PER_TOKEN = 1.5;
const MAX_TEXT_LENGTH_PER_MESSAGE = 500;
const SUMMARY_PREFIX = "Previous conversation summary:";
const SYSTEM_CONTEXT_PREFIX = "Previous conversation context:";

// CJK Unicode ranges for improved token estimation
const CJK_REGEX =
  /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3100-\u312F\u3130-\u318F\u3200-\u32FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF]/g;

// ID generation counter for summaries
let summaryIdCounter = 0;

/**
 * Sanitize summary text to prevent prompt injection.
 * Removes potential system message boundaries and control characters.
 */
function sanitizeSummaryText(text: string): string {
  // Remove XML-like tags that could be interpreted as system boundaries
  return text
    .replace(/<\s*(\/?)\s*(system|user|assistant)\s*>/gi, "[$1$2]")
    .split("")
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 0x0a || code > 0x1f;
    })
    .join("");
}

/**
 * Improved token estimator that accounts for CJK characters.
 * CJK characters typically map to ~1-2 tokens each (vs ~4 chars/token for Latin).
 */
export function estimateTokens(text: string): number {
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = text.length - cjkCount;

  const cjkTokens = cjkCount / CJK_CHARS_PER_TOKEN;
  const nonCjkTokens = nonCjkCount / LATIN_CHARS_PER_TOKEN;

  return Math.ceil(cjkTokens + nonCjkTokens);
}

const SPECULATIVE_BUFFER_TOKENS = 4096;
const FALLBACK_SPECULATIVE_RATIO = 0.6;
const MAX_SPECULATIVE_RATIO = 0.95;
const MIN_SPECULATIVE_RATIO = 0.15;

/**
 * Compute the speculative compaction start ratio for a given context window.
 *
 * Tuned for medium-to-large contexts (20k+ tokens). The fixed 4096-token
 * headroom buffer becomes meaningless for tiny windows (e.g. 600 tokens),
 * where the fallback heuristic in {@link shouldStartSpeculativeCompactionForNextTurn}
 * (`contextLimit - 2 * reserveTokens`) is more appropriate.
 *
 * For sub-8k contexts, prefer omitting `speculativeStartRatio` from the
 * compaction config and letting the fallback take over.
 */
export function computeSpeculativeStartRatio(
  contextLength: number,
  reserveTokens = 0
): number {
  if (
    !(Number.isFinite(contextLength) && Number.isFinite(reserveTokens)) ||
    contextLength <= 0
  ) {
    return FALLBACK_SPECULATIVE_RATIO;
  }

  // Normalize reserveTokens: clamp to [0, contextLength - 1]
  const normalizedReserve = Math.max(
    0,
    Math.min(reserveTokens, contextLength - 1)
  );

  const ratio =
    (contextLength - normalizedReserve - SPECULATIVE_BUFFER_TOKENS) /
    contextLength;

  // Final clamp: ratio must satisfy floor(ctx * ratio) < (ctx - reserve).
  // -1 ensures strict inequality; applied AFTER min/max to override MIN_SPECULATIVE_RATIO.
  const hardThresholdRatio =
    (contextLength - normalizedReserve - 1) / contextLength;

  const clamped = Math.max(
    MIN_SPECULATIVE_RATIO,
    Math.min(MAX_SPECULATIVE_RATIO, ratio)
  );

  return Math.min(clamped, hardThresholdRatio);
}

/**
 * Extract text content from a message for token estimation.
 */
function extractMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .map((part) => {
      if (typeof part === "object" && part !== null) {
        if (part.type === "text") {
          return (part as TextPart).text;
        }
        if (part.type === "tool-call") {
          return `${part.toolName} ${JSON.stringify(part.input)}`;
        }
        if (part.type === "tool-result") {
          return `${part.toolName} ${JSON.stringify(part.output)}`;
        }
      }
      return "";
    })
    .join(" ");
}

/**
 * Calculate estimated token count for an array of messages.
 */
function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((total, msg) => {
    return total + estimateTokens(extractMessageText(msg));
  }, 0);
}

/**
 * Check if a message contains tool-call parts.
 */
function hasToolCalls(message: ModelMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some(
    (part) =>
      typeof part === "object" && part !== null && part.type === "tool-call"
  );
}

function isToolResultContentPart(part: unknown): part is {
  output: unknown;
  toolName: string;
  type: "tool-result";
} {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "tool-result" &&
    "toolName" in part &&
    "output" in part
  );
}

function moveSplitIndexPastToolResults(
  messages: { modelMessage: ModelMessage }[],
  index: number
): number {
  let adjustedIndex = index;
  while (
    adjustedIndex < messages.length &&
    messages[adjustedIndex].modelMessage.role === "tool"
  ) {
    adjustedIndex++;
  }
  return adjustedIndex;
}

function shouldPullAssistantIntoKeptMessages(
  messages: { modelMessage: ModelMessage }[],
  proposedIndex: number,
  adjustedIndex: number
): boolean {
  if (adjustedIndex !== proposedIndex || adjustedIndex <= 0) {
    return false;
  }

  const previousMessage = messages[adjustedIndex - 1];
  return (
    previousMessage !== undefined &&
    hasToolCalls(previousMessage.modelMessage) &&
    adjustedIndex < messages.length &&
    messages[adjustedIndex].modelMessage.role === "tool"
  );
}

/**
 * Find a valid split index that preserves tool-call/tool-result pairs.
 * If the proposed splitIndex would split a tool-call from its tool-result,
 * adjust it to keep the pair together (either both summarized or both kept).
 */
function adjustSplitIndexForToolPairs(
  messages: { modelMessage: ModelMessage }[],
  proposedIndex: number
): number {
  if (proposedIndex <= 0 || proposedIndex >= messages.length) {
    return proposedIndex;
  }

  const adjustedIndex = moveSplitIndexPastToolResults(messages, proposedIndex);
  if (adjustedIndex <= 0) {
    return proposedIndex;
  }

  if (
    shouldPullAssistantIntoKeptMessages(messages, proposedIndex, adjustedIndex)
  ) {
    return adjustedIndex - 1;
  }

  return adjustedIndex;
}

function trimTrailingNewlines(message: ModelMessage): ModelMessage {
  if (message.role !== "assistant") {
    return message;
  }

  const content = message.content;

  if (typeof content === "string") {
    const trimmed = content.replace(TRAILING_NEWLINES, "");
    if (trimmed === content) {
      return message;
    }
    return { ...message, content: trimmed };
  }

  if (!Array.isArray(content) || content.length === 0) {
    return message;
  }

  let lastTextIndex = -1;
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (part && typeof part === "object" && part.type === "text") {
      lastTextIndex = i;
      break;
    }
  }

  if (lastTextIndex === -1) {
    return message;
  }

  const textPart = content[lastTextIndex] as TextPart;
  const trimmedText = textPart.text.replace(TRAILING_NEWLINES, "");

  if (trimmedText === textPart.text) {
    return message;
  }

  const newContent = [...content];
  newContent[lastTextIndex] = { ...textPart, text: trimmedText };

  return { ...message, content: newContent };
}

export interface Message {
  createdAt: Date;
  id: string;
  modelMessage: ModelMessage;
  originalContent?: string;
}

/**
 * Actual token usage reported by the API after a streaming turn.
 * Preferred over character-based estimation for compaction decisions.
 */
export interface ActualTokenUsage {
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
  updatedAt: Date;
}

/**
 * Snapshot of context utilization for display purposes.
 * Returned by `getContextUsage()`.
 */
export interface ContextUsage {
  limit: number;
  percentage: number;
  remaining: number;
  source: "actual" | "estimated";
  used: number;
}

/**
 * Summary entry representing a compacted batch of messages.
 */
export interface CompactionSummary {
  createdAt: Date;
  /** ID of the first message that was kept after this summary */
  firstKeptMessageId: string;
  id: string;
  summary: string;
  /** Estimated tokens in the summary */
  summaryTokens: number;
  /** Estimated tokens before compaction */
  tokensBefore: number;
}

export interface PreparedCompaction {
  actualUsage: ActualTokenUsage | null;
  baseMessageIds: string[];
  baseRevision: number;
  baseSummaryIds: string[];
  compactionMaxTokensAtCreation: number;
  contextLimitAtCreation: number;
  didChange: boolean;
  keepRecentTokensAtCreation: number;
  messages: Message[];
  pendingCompaction: boolean;
  phase: "intermediate-step" | "new-turn";
  rejected: boolean;
  summaries: CompactionSummary[];
  tokenDelta: number;
}

/**
 * Configuration for the incremental compaction feature.
 */
export interface CompactionConfig {
  /**
   * Enable incremental compaction. When enabled, older messages are
   * summarized when context exceeds token thresholds.
   * @default false
   */
  enabled?: boolean;

  /**
   * Number of recent tokens to preserve from compaction.
   * These messages are always kept in full form.
   * @default 2000
   */
  keepRecentTokens?: number;

  /**
   * Maximum total tokens before triggering compaction.
   * When exceeded, older messages will be summarized.
   * @default 8000
   */
  maxTokens?: number;

  /**
   * Reserve tokens for the response. Compaction triggers when
   * (totalTokens + reserveTokens) > maxTokens.
   * @default 2000
   */
  reserveTokens?: number;

  /**
   * Optional ratio for starting speculative/background compaction early.
   * When set, speculative compaction starts once current usage reaches
   * `maxTokens * speculativeStartRatio`.
   *
   * If omitted or invalid, the fallback heuristic is used:
   * `maxTokens - 2 * reserveTokens`.
   *
   * For sub-8k contexts, omit this field and let the fallback heuristic
   * handle it. See {@link computeSpeculativeStartRatio} for details.
   */
  speculativeStartRatio?: number;

  /**
   * Custom function to summarize a batch of messages.
   * If not provided, an improved extraction-based fallback is used.
   *
   * @param messages - The messages to summarize
   * @param previousSummary - Optional previous summary to build upon (iterative compaction)
   */
  summarizeFn?: (
    messages: ModelMessage[],
    previousSummary?: string
  ) => Promise<string>;
}

export interface MessageHistoryOptions {
  /**
   * Incremental compaction configuration for managing long contexts.
   * When enabled, older messages are summarized to reduce token usage
   * while preserving important context.
   */
  compaction?: CompactionConfig;
  /**
   * Maximum number of messages to retain. When exceeded, older messages
   * are trimmed from the front while preserving the initial user message
   * for context continuity. Defaults to 1000.
   */
  maxMessages?: number;

  /**
   * Tool output pruning configuration.
   * When enabled, large tool outputs outside a recent token window
   * are replaced with stubs before compaction runs, potentially
   * avoiding expensive LLM-based compaction entirely.
   */
  pruning?: PruningConfig;
}

const createMessageId = (() => {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `msg_${counter}`;
  };
})();

const DEFAULT_MAX_MESSAGES = 1000;
const DEFAULT_COMPACTION_MAX_TOKENS = 8000;
const DEFAULT_COMPACTION_KEEP_RECENT = 2000;
const DEFAULT_COMPACTION_RESERVE = 2000;
const INTERMEDIATE_STEP_RESERVE_MULTIPLIER = 2;

type MessagePreparationPhase = "new-turn" | "intermediate-step";

interface CompactionCheckOptions {
  phase?: MessagePreparationPhase;
}

type SummaryDeltaCallback = (delta: string) => void | Promise<void>;

type CompactOptions = CompactionCheckOptions & {
  aggressive?: boolean;
  allowPruning?: boolean;
  onSummaryDelta?: SummaryDeltaCallback;
  summarizeFn?: (
    messages: ModelMessage[],
    previousSummary?: string,
    onSummaryDelta?: SummaryDeltaCallback
  ) => Promise<string>;
};

type MessagePreparationOptions = CompactionCheckOptions & {
  allowPruning?: boolean;
  onSummaryDelta?: SummaryDeltaCallback;
  summarizeFn?: (
    messages: ModelMessage[],
    previousSummary?: string,
    onSummaryDelta?: SummaryDeltaCallback
  ) => Promise<string>;
};

/**
 * Improved default summarizer that extracts conversation essence.
 * Groups messages by turns, prioritizes user intents and assistant decisions,
 * and drops verbose tool outputs.
 * Output is sanitized to prevent prompt injection and structured with
 * clear sections for context preservation.
 */
function truncateWithEllipsis(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function getToolNamesFromMessage(message: ModelMessage): string {
  if (!Array.isArray(message.content)) {
    return "tool";
  }

  const toolNames: string[] = [];
  for (const part of message.content) {
    if (isToolResultContentPart(part)) {
      toolNames.push(part.toolName);
    }
  }

  return toolNames.join(", ") || "tool";
}

function buildTopicEntries(userIntents: string[]): string[] {
  if (userIntents.length <= 4) {
    return userIntents;
  }

  const lastIntent = userIntents.at(-1);
  return lastIntent
    ? [
        ...userIntents.slice(0, 2),
        `(... ${userIntents.length - 3} more)`,
        lastIntent,
      ]
    : userIntents;
}

function buildConversationSection(turns: string[]): string {
  if (turns.length <= 6) {
    return turns.join("\n---\n");
  }

  return [
    ...turns.slice(0, 2),
    `[... ${turns.length - 4} turns omitted ...]`,
    ...turns.slice(-2),
  ].join("\n---\n");
}

interface SummaryBuildState {
  assistantResponses: string[];
  currentTurn: string[];
  toolUsage: string[];
  turns: string[];
  userIntents: string[];
}

function createSummaryBuildState(): SummaryBuildState {
  return {
    assistantResponses: [],
    currentTurn: [],
    toolUsage: [],
    turns: [],
    userIntents: [],
  };
}

function finalizeSummaryTurn(state: SummaryBuildState): void {
  if (state.currentTurn.length === 0) {
    return;
  }

  state.turns.push(state.currentTurn.join("\n"));
  state.currentTurn = [];
}

function appendToolMessageToSummaryState(
  state: SummaryBuildState,
  message: ModelMessage,
  text: string
): void {
  const toolName = sanitizeSummaryText(getToolNamesFromMessage(message));
  const briefOutput = sanitizeSummaryText(truncateWithEllipsis(text, 100));
  state.currentTurn.push(`  [tool:${toolName}]: ${briefOutput}`);
  if (!state.toolUsage.includes(toolName)) {
    state.toolUsage.push(toolName);
  }
}

function appendConversationMessageToSummaryState(
  state: SummaryBuildState,
  message: ModelMessage,
  text: string
): void {
  if (message.role === "user" && state.currentTurn.length > 0) {
    finalizeSummaryTurn(state);
  }

  const truncated = truncateWithEllipsis(text, MAX_TEXT_LENGTH_PER_MESSAGE);
  const sanitizedRole = sanitizeSummaryText(message.role);
  const sanitizedContent = sanitizeSummaryText(truncated);
  state.currentTurn.push(`[${sanitizedRole}]: ${sanitizedContent}`);

  if (message.role === "user") {
    const intent = sanitizeSummaryText(text.slice(0, 150));
    if (intent.trim()) {
      state.userIntents.push(intent);
    }
  }

  if (message.role === "assistant" && text.trim()) {
    const response = sanitizeSummaryText(text.slice(0, 150));
    if (response.trim()) {
      state.assistantResponses.push(response);
    }
  }
}

function collectSummaryBuildState(messages: ModelMessage[]): SummaryBuildState {
  const state = createSummaryBuildState();

  for (const message of messages) {
    const text = extractMessageText(message);
    if (message.role === "tool") {
      appendToolMessageToSummaryState(state, message, text);
      continue;
    }

    appendConversationMessageToSummaryState(state, message, text);
  }

  finalizeSummaryTurn(state);
  return state;
}

function buildSummarySections(
  state: SummaryBuildState,
  previousSummary?: string
): string[] {
  const sections: string[] = [];

  if (previousSummary) {
    sections.push(`Previous Context:\n${sanitizeSummaryText(previousSummary)}`);
  }

  if (state.userIntents.length > 0) {
    const topicEntries = buildTopicEntries(state.userIntents);
    sections.push(
      `Key Topics:\n${topicEntries.map((topic) => `- ${topic}`).join("\n")}`
    );
  }

  if (state.toolUsage.length > 0) {
    sections.push(`Tools Used: ${state.toolUsage.join(", ")}`);
  }

  sections.push(`Conversation:\n${buildConversationSection(state.turns)}`);

  if (state.assistantResponses.length > 0) {
    const lastResponse = state.assistantResponses.at(-1);
    sections.push(`Last Response: ${lastResponse}`);
  }

  return sections;
}

function defaultSummarizeFn(
  messages: ModelMessage[],
  previousSummary?: string
): Promise<string> {
  if (messages.length === 0) {
    return Promise.resolve(
      sanitizeSummaryText(`${SUMMARY_PREFIX}\n(empty conversation)`)
    );
  }

  const state = collectSummaryBuildState(messages);
  const sections = buildSummarySections(state, previousSummary);
  const summary = `${SUMMARY_PREFIX}\n${sections.join("\n\n")}`;
  return Promise.resolve(sanitizeSummaryText(summary));
}

function cloneActualUsage(
  usage: ActualTokenUsage | null
): ActualTokenUsage | null {
  if (!usage) {
    return null;
  }

  return {
    ...usage,
    updatedAt: new Date(usage.updatedAt),
  };
}

function cloneCompactionSummary(summary: CompactionSummary): CompactionSummary {
  return {
    ...summary,
    createdAt: new Date(summary.createdAt),
  };
}

function cloneMessage(message: Message): Message {
  return {
    ...message,
    createdAt: new Date(message.createdAt),
  };
}

export class MessageHistory {
  private messages: Message[] = [];
  private readonly maxMessages: number;
  private readonly compaction: CompactionConfig;
  private readonly pruning: PruningConfig;
  private summaries: CompactionSummary[] = [];
  private _lastCompactionRejected = false;
  private compactionInProgress = false;
  private pendingCompaction = false;
  private actualUsage: ActualTokenUsage | null = null;
  private contextLimit = 0;
  private revision = 0;

  constructor(options?: MessageHistoryOptions) {
    const max = options?.maxMessages ?? DEFAULT_MAX_MESSAGES;
    if (!Number.isFinite(max) || max < 1 || max !== Math.floor(max)) {
      throw new RangeError(
        `maxMessages must be a positive integer >= 1, got ${max}`
      );
    }
    this.maxMessages = max;

    this.compaction = {
      enabled: options?.compaction?.enabled ?? false,
      maxTokens:
        options?.compaction?.maxTokens ?? DEFAULT_COMPACTION_MAX_TOKENS,
      keepRecentTokens:
        options?.compaction?.keepRecentTokens ?? DEFAULT_COMPACTION_KEEP_RECENT,
      reserveTokens:
        options?.compaction?.reserveTokens ?? DEFAULT_COMPACTION_RESERVE,
      speculativeStartRatio: options?.compaction?.speculativeStartRatio,
      summarizeFn: options?.compaction?.summarizeFn,
    };

    this.pruning = {
      enabled: options?.pruning?.enabled ?? false,
      protectRecentTokens: options?.pruning?.protectRecentTokens,
      minSavingsTokens: options?.pruning?.minSavingsTokens,
      protectedToolNames: options?.pruning?.protectedToolNames,
      replacementText: options?.pruning?.replacementText,
    };
  }

  getAll(): Message[] {
    return [...this.messages];
  }

  getSummaries(): CompactionSummary[] {
    return [...this.summaries];
  }

  get lastCompactionRejected(): boolean {
    return this._lastCompactionRejected;
  }

  clear(): void {
    this.messages = [];
    this.summaries = [];
    this.actualUsage = null;
    this.pendingCompaction = false;
    this.touch();
  }

  /**
   * Check if compaction is enabled.
   */
  isCompactionEnabled(): boolean {
    return this.compaction.enabled === true;
  }

  /**
   * Get the current compaction configuration.
   */
  getCompactionConfig(): Readonly<CompactionConfig> {
    return { ...this.compaction };
  }

  /**
   * Check if pruning is enabled.
   */
  isPruningEnabled(): boolean {
    return this.pruning.enabled === true;
  }

  getPruningConfig(): Readonly<PruningConfig> {
    return { ...this.pruning };
  }

  setContextLimit(limit: number): void {
    if (this.contextLimit === limit) {
      return;
    }
    this.contextLimit = limit;
    this.touch();
  }

  getContextLimit(): number {
    return this.contextLimit;
  }

  private invalidateActualUsage(): void {
    this.actualUsage = null;
  }

  private adjustActualUsageAfterReduction(estimatedTokensSaved: number): void {
    if (!this.actualUsage || estimatedTokensSaved <= 0) {
      return;
    }
    this.actualUsage = {
      ...this.actualUsage,
      totalTokens: Math.max(
        0,
        this.actualUsage.totalTokens - estimatedTokensSaved
      ),
      updatedAt: new Date(),
    };
  }

  private touch(): void {
    this.revision += 1;
  }

  private setPendingCompaction(value: boolean): void {
    if (this.pendingCompaction === value) {
      return;
    }
    this.pendingCompaction = value;
    this.touch();
  }

  updateActualUsage(usage: {
    completionTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    promptTokens?: number;
    totalTokens?: number;
  }): void {
    const prompt = usage.promptTokens ?? usage.inputTokens ?? 0;
    const completion = usage.completionTokens ?? usage.outputTokens ?? 0;
    const total = usage.totalTokens ?? prompt + completion;

    this.actualUsage = {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      updatedAt: new Date(),
    };
    this.touch();
  }

  getActualUsage(): Readonly<ActualTokenUsage> | null {
    return this.actualUsage ? { ...this.actualUsage } : null;
  }

  getContextUsage(): ContextUsage | null {
    const limit = this.contextLimit;
    if (limit <= 0) {
      return null;
    }

    if (this.actualUsage) {
      const used = this.actualUsage.totalTokens;
      const remaining = Math.max(0, limit - used);
      const percentage = Math.min(100, Math.round((used / limit) * 100));
      return { used, limit, remaining, percentage, source: "actual" };
    }

    const estimated = this.getEstimatedTokens();
    const remaining = Math.max(0, limit - estimated);
    const percentage = Math.min(100, Math.round((estimated / limit) * 100));
    return {
      used: estimated,
      limit,
      remaining,
      percentage,
      source: "estimated",
    };
  }

  /**
   * Update compaction configuration dynamically.
   * Useful when switching models with different context limits.
   */
  updateCompaction(config: Partial<CompactionConfig>): void {
    let didChange = false;
    if (config.enabled !== undefined) {
      didChange ||= this.compaction.enabled !== config.enabled;
      this.compaction.enabled = config.enabled;
    }
    if (config.maxTokens !== undefined) {
      didChange ||= this.compaction.maxTokens !== config.maxTokens;
      this.compaction.maxTokens = config.maxTokens;
    }
    if (config.keepRecentTokens !== undefined) {
      didChange ||=
        this.compaction.keepRecentTokens !== config.keepRecentTokens;
      this.compaction.keepRecentTokens = config.keepRecentTokens;
    }
    if (config.reserveTokens !== undefined) {
      didChange ||= this.compaction.reserveTokens !== config.reserveTokens;
      this.compaction.reserveTokens = config.reserveTokens;
    }
    if (config.speculativeStartRatio !== undefined) {
      didChange ||=
        this.compaction.speculativeStartRatio !== config.speculativeStartRatio;
      this.compaction.speculativeStartRatio = config.speculativeStartRatio;
    }
    if (config.summarizeFn !== undefined) {
      didChange ||= this.compaction.summarizeFn !== config.summarizeFn;
      this.compaction.summarizeFn = config.summarizeFn;
    }

    if (didChange) {
      this.touch();
    }
  }

  /**
   * Get the current estimated token count.
   */
  getEstimatedTokens(): number {
    const messagesTokens = estimateMessagesTokens(this.toModelMessages());
    const summariesTokens = this.summaries.reduce(
      (total, s) => total + s.summaryTokens,
      0
    );
    return messagesTokens + summariesTokens;
  }

  private getActiveContextLimit(): number {
    if (this.contextLimit > 0) {
      return this.contextLimit;
    }

    return this.compaction.maxTokens ?? DEFAULT_COMPACTION_MAX_TOKENS;
  }

  private getCurrentUsageTokens(): number {
    if (this.actualUsage && this.contextLimit > 0) {
      return this.actualUsage.totalTokens;
    }

    return this.getEstimatedTokens();
  }

  shouldStartSpeculativeCompactionForNextTurn(): boolean {
    if (
      !(this.compaction.enabled || this.pruning.enabled) ||
      this.messages.length === 0
    ) {
      return false;
    }

    const contextLimit = this.getActiveContextLimit();
    const speculativeStartRatio = this.compaction.speculativeStartRatio;
    const predictiveThreshold =
      typeof speculativeStartRatio === "number" &&
      Number.isFinite(speculativeStartRatio) &&
      speculativeStartRatio > 0 &&
      speculativeStartRatio < 1
        ? Math.floor(contextLimit * speculativeStartRatio)
        : Math.max(
            0,
            contextLimit -
              this.getEffectiveReserveTokens({ phase: "new-turn" }) * 2
          );

    return this.getCurrentUsageTokens() >= predictiveThreshold;
  }

  async prepareSpeculativeCompaction(
    options?: MessagePreparationOptions
  ): Promise<PreparedCompaction | null> {
    if (
      !(this.compaction.enabled || this.pruning.enabled) ||
      this.messages.length === 0
    ) {
      return null;
    }

    const baseRevision = this.revision;
    const baseMessageIds = this.messages.map((message) => message.id);
    const baseSummaryIds = this.summaries.map((summary) => summary.id);
    const contextLimitAtCreation = this.getContextLimit();
    const compactionMaxTokensAtCreation =
      this.compaction.maxTokens ?? DEFAULT_COMPACTION_MAX_TOKENS;
    const keepRecentTokensAtCreation = this.compaction.keepRecentTokens ?? 0;
    const clone = this.cloneForSpeculativeCompaction();
    const preCompactionTokens = clone.actualUsage?.totalTokens ?? 0;
    const allowPruning =
      options?.allowPruning ?? options?.phase !== "intermediate-step";
    await clone.compact({
      allowPruning,
      onSummaryDelta: options?.onSummaryDelta,
      summarizeFn: options?.summarizeFn,
      phase: options?.phase,
    });
    clone.setPendingCompaction(false);
    const postCompactionTokens = clone.actualUsage?.totalTokens ?? 0;

    return {
      actualUsage: cloneActualUsage(clone.actualUsage),
      baseMessageIds,
      baseRevision,
      baseSummaryIds,
      compactionMaxTokensAtCreation,
      contextLimitAtCreation,
      didChange: clone.revision !== baseRevision,
      keepRecentTokensAtCreation,
      messages: clone.messages.map(cloneMessage),
      pendingCompaction: clone.pendingCompaction,
      phase: options?.phase ?? "new-turn",
      rejected: clone.lastCompactionRejected,
      summaries: clone.summaries.map(cloneCompactionSummary),
      tokenDelta: Math.max(0, preCompactionTokens - postCompactionTokens),
    };
  }

  applyPreparedCompaction(prepared: PreparedCompaction): {
    applied: boolean;
    reason: "applied" | "noop" | "stale" | "rejected";
  } {
    if (
      prepared.contextLimitAtCreation !== this.getContextLimit() ||
      prepared.compactionMaxTokensAtCreation !==
        (this.compaction.maxTokens ?? DEFAULT_COMPACTION_MAX_TOKENS) ||
      prepared.keepRecentTokensAtCreation !==
        (this.compaction.keepRecentTokens ?? 0)
    ) {
      return { applied: false, reason: "stale" };
    }

    const hasExactRevisionMatch = prepared.baseRevision === this.revision;
    const hasMatchingSummaryPrefix =
      this.summaries.length === prepared.baseSummaryIds.length &&
      this.summaries.every(
        (summary, index) => summary.id === prepared.baseSummaryIds[index]
      );
    const hasMatchingMessagePrefix =
      this.messages.length >= prepared.baseMessageIds.length &&
      prepared.baseMessageIds.every(
        (messageId, index) => this.messages[index]?.id === messageId
      );

    if (
      !(
        hasExactRevisionMatch ||
        (hasMatchingSummaryPrefix && hasMatchingMessagePrefix)
      )
    ) {
      return { applied: false, reason: "stale" };
    }

    if (prepared.rejected) {
      return { applied: false, reason: "rejected" };
    }

    if (!prepared.didChange) {
      return { applied: false, reason: "noop" };
    }

    const appendedMessages = hasExactRevisionMatch
      ? []
      : this.messages.slice(prepared.baseMessageIds.length).map(cloneMessage);

    this.messages = [
      ...prepared.messages.map(cloneMessage),
      ...appendedMessages,
    ];
    this.summaries = prepared.summaries.map(cloneCompactionSummary);
    this.pendingCompaction =
      appendedMessages.length > 0 ? true : prepared.pendingCompaction;
    this.adjustActualUsageAfterReduction(prepared.tokenDelta);
    this.touch();

    return { applied: true, reason: "applied" };
  }

  wouldExceedContextWithAdditionalMessage(
    content: string,
    options?: CompactionCheckOptions
  ): boolean {
    if (!(this.compaction.enabled || this.pruning.enabled)) {
      return false;
    }

    const reserveTokens = this.getEffectiveReserveTokens(options);
    const totalTokens =
      this.getCurrentUsageTokens() + estimateTokens(content) + reserveTokens;

    return totalTokens >= this.getActiveContextLimit();
  }

  private cloneForSpeculativeCompaction(): MessageHistory {
    const clone = new MessageHistory({
      compaction: { ...this.compaction },
      maxMessages: this.maxMessages,
      pruning: { ...this.pruning },
    });

    clone.messages = this.messages.map(cloneMessage);
    clone.summaries = this.summaries.map(cloneCompactionSummary);
    clone.pendingCompaction = this.pendingCompaction;
    clone.actualUsage = cloneActualUsage(this.actualUsage);
    clone.contextLimit = this.contextLimit;
    clone.revision = this.revision;

    return clone;
  }

  private getEffectiveReserveTokens(options?: CompactionCheckOptions): number {
    const reserveTokens =
      this.compaction.reserveTokens ?? DEFAULT_COMPACTION_RESERVE;

    if (options?.phase === "intermediate-step") {
      return reserveTokens * INTERMEDIATE_STEP_RESERVE_MULTIPLIER;
    }

    return reserveTokens;
  }

  /**
   * Check if compaction is needed based on current token count.
   * This is a synchronous check — no compaction is performed.
   */
  needsCompaction(options?: CompactionCheckOptions): boolean {
    if (!this.compaction.enabled || this.messages.length === 0) {
      return false;
    }

    const reserveTokens = this.getEffectiveReserveTokens(options);

    // Prefer actual API-reported usage over character-based estimation
    if (this.actualUsage && this.contextLimit > 0) {
      return this.actualUsage.totalTokens + reserveTokens >= this.contextLimit;
    }

    const totalTokens = this.getEstimatedTokens();
    const threshold =
      (this.compaction.maxTokens ?? DEFAULT_COMPACTION_MAX_TOKENS) -
      reserveTokens;

    return totalTokens >= threshold;
  }

  isAtHardContextLimit(
    additionalTokens?: number,
    options?: CompactionCheckOptions
  ): boolean {
    if (!(this.compaction.enabled || this.pruning.enabled)) {
      return false;
    }

    const currentUsageTokens =
      this.actualUsage?.totalTokens ?? this.getEstimatedTokens();
    const effectiveReserveTokens = this.getEffectiveReserveTokens(options);
    const activeContextLimit = this.getActiveContextLimit();

    return (
      currentUsageTokens + (additionalTokens ?? 0) + effectiveReserveTokens >=
      activeContextLimit
    );
  }

  /**
   * Trigger compaction manually. Returns true if compaction was performed.
   * When pruning is enabled, it runs first. If pruning alone brings
   * the token count below the compaction threshold, compaction is skipped.
   */
  async compact(options?: CompactOptions): Promise<boolean> {
    if (this.messages.length === 0) {
      return false;
    }

    // Prevent concurrent compaction (race condition fix)
    if (this.compactionInProgress) {
      return false;
    }

    // Run pruning first if enabled
    let pruned = false;
    const allowPruning = options?.allowPruning ?? true;
    if (allowPruning && this.pruning.enabled) {
      pruned = this.performPruning();
    }

    if (!this.compaction.enabled) {
      return pruned;
    }

    // If pruning brought us below threshold, skip compaction
    if (pruned && !this.needsCompaction(options)) {
      return true;
    }

    const compacted = await this.performCompaction(
      options?.summarizeFn,
      options?.onSummaryDelta,
      options?.aggressive ?? false
    );
    return pruned || compacted;
  }

  addUserMessage(content: string, originalContent?: string): Message {
    const message: Message = {
      id: createMessageId(),
      createdAt: new Date(),
      modelMessage: {
        role: "user",
        content,
      },
      originalContent,
    };
    this.messages.push(message);
    this.enforceLimit();
    this.invalidateActualUsage();
    this.touch();
    // Mark that compaction may be needed — actual compaction happens
    // at getMessagesForLLM() or via explicit compact() call
    this.markCompactionNeeded();
    return message;
  }

  addModelMessages(messages: ModelMessage[]): Message[] {
    const created: Message[] = [];
    for (const modelMessage of messages) {
      const processedMessage = trimTrailingNewlines(modelMessage);
      const sanitizedMessage = this.sanitizeMessage(processedMessage);

      const message: Message = {
        id: createMessageId(),
        createdAt: new Date(),
        modelMessage: sanitizedMessage,
      };
      created.push(message);
    }
    this.messages.push(...created);
    this.enforceLimit();
    this.invalidateActualUsage();
    this.touch();
    // Mark that compaction may be needed
    this.markCompactionNeeded();
    return created;
  }

  /**
   * Synchronously mark that compaction check is needed.
   * No async work is done here — avoids the fire-and-forget race condition.
   */
  private markCompactionNeeded(): void {
    if (!(this.compaction.enabled || this.pruning.enabled)) {
      return;
    }
    this.setPendingCompaction(true);
  }

  /**
   * Get messages with compaction summaries prepended as system context.
   * This is the recommended way to get messages for LLM calls when
   * compaction is enabled.
   *
   * If compaction is pending and needed, it is performed synchronously
   * within this call (the summarizeFn is awaited). For synchronous access
   * without triggering compaction, use toModelMessages() instead.
   *
   * Security: Summary content is sanitized to prevent prompt injection.
   * User content cannot escalate to system privileges through this method.
   */
  getMessagesForLLM(): ModelMessage[] {
    const modelMessages = this.toModelMessages();

    if (this.summaries.length === 0) {
      return modelMessages;
    }

    // Combine summaries into a single system message
    // Each summary is already sanitized during creation, but we double-check here
    const combinedSummary = this.summaries
      .map((s) => `---\n${sanitizeSummaryText(s.summary)}`)
      .join("\n");

    // Use sanitized prefix constant to prevent injection through prefix
    const systemMessage: ModelMessage = {
      role: "system",
      content: `${SYSTEM_CONTEXT_PREFIX}\n${combinedSummary}`,
    };

    return [systemMessage, ...modelMessages];
  }

  /**
   * Async version of getMessagesForLLM that performs pending compaction
   * before returning messages. This ensures compaction happens at the
   * point of use rather than fire-and-forget.
   *
   * @deprecated Use getMessagesForLLM() instead. This method no longer performs
   * inline compaction. Compaction is now handled separately via
   * prepareSpeculativeCompaction() and applyPreparedCompaction().
   */
  // biome-ignore lint/suspicious/useAwait: deprecated method kept async for backward compatibility
  async getMessagesForLLMAsync(
    _options?: MessagePreparationOptions
  ): Promise<ModelMessage[]> {
    return this.getMessagesForLLM();
  }

  /**
   * Apply tool output pruning to messages in-place.
   * Returns true if any outputs were pruned.
   */
  private performPruning(): boolean {
    const modelMessages = this.messages.map((m) => m.modelMessage);
    const result = pruneToolOutputs(modelMessages, this.pruning);

    if (result.prunedTokens === 0) {
      return false;
    }

    // Update messages with pruned model messages
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].modelMessage !== result.messages[i]) {
        this.messages[i] = {
          ...this.messages[i],
          modelMessage: result.messages[i],
        };
      }
    }

    this.adjustActualUsageAfterReduction(result.prunedTokens);
    this.touch();

    return true;
  }

  private calculateCompactionSplitIndex(aggressive: boolean): number | null {
    return aggressive
      ? this.calculateAggressiveCompactionSplitIndex()
      : this.calculateDefaultCompactionSplitIndex();
  }

  private calculateDefaultCompactionSplitIndex(): number | null {
    const keepRecentTokens =
      this.compaction.keepRecentTokens ?? DEFAULT_COMPACTION_KEEP_RECENT;

    let keptTokens = 0;
    let splitIndex = this.messages.length;

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(
        extractMessageText(this.messages[i].modelMessage)
      );

      if (keptTokens + msgTokens > keepRecentTokens) {
        splitIndex = i + 1;
        break;
      }

      keptTokens += msgTokens;

      if (i === 0) {
        splitIndex = 0;
      }
    }

    if (splitIndex === 0) {
      if (this.messages.length <= 1) {
        return null;
      }
      splitIndex = Math.max(1, Math.floor(this.messages.length / 2));
    }

    if (splitIndex >= this.messages.length) {
      return null;
    }

    splitIndex = adjustSplitIndexForToolPairs(this.messages, splitIndex);
    if (splitIndex >= this.messages.length || splitIndex <= 0) {
      return null;
    }

    return splitIndex;
  }

  private calculateAggressiveCompactionSplitIndex(): number | null {
    return this.messages.length > 1 ? this.messages.length : null;
  }

  private async performCompaction(
    summarizeFnOverride?: (
      messages: ModelMessage[],
      previousSummary?: string,
      onSummaryDelta?: SummaryDeltaCallback
    ) => Promise<string>,
    onSummaryDelta?: SummaryDeltaCallback,
    aggressive = false
  ): Promise<boolean> {
    this._lastCompactionRejected = false;

    if (this.messages.length === 0) {
      return false;
    }

    this.compactionInProgress = true;

    try {
      const splitIndex = this.calculateCompactionSplitIndex(aggressive);
      if (splitIndex === null) {
        return false;
      }

      // Messages to summarize (before splitIndex)
      const messagesToSummarize = this.messages.slice(0, splitIndex);
      // Messages to keep as-is (splitIndex onwards)
      const messagesToKeep = aggressive ? [] : this.messages.slice(splitIndex);

      if (messagesToSummarize.length === 0) {
        return false;
      }

      // Get the first kept message ID
      const firstKeptMessageId =
        aggressive || messagesToKeep.length === 0
          ? "end"
          : messagesToKeep[0].id;

      // Combine existing summaries into previousSummary for iterative compaction
      // The iterative compaction invariant guarantees at most one summary entry.
      // Access directly rather than mapping/joining.
      const previousSummary = this.summaries[0]?.summary;

      // Summarize with error handling and fallback
      const summarizeFn =
        summarizeFnOverride ??
        this.compaction.summarizeFn ??
        defaultSummarizeFn;
      const modelMessagesToSummarize = messagesToSummarize.map(
        (m) => m.modelMessage
      );

      let summary: string;
      try {
        summary = await summarizeFn(
          modelMessagesToSummarize,
          previousSummary,
          onSummaryDelta
        );
      } catch (error) {
        // Fallback to default summarizer if custom one fails
        console.warn("Custom summarizeFn failed, using fallback:", error);
        summary = await defaultSummarizeFn(
          modelMessagesToSummarize,
          previousSummary
        );
      }

      // Sanitize summary to prevent prompt injection
      summary = sanitizeSummaryText(summary);
      const summaryTokens = estimateTokens(summary);

      // Create summary entry with unique ID (timestamp + counter + random)
      summaryIdCounter += 1;
      const summaryEntry: CompactionSummary = {
        id: `summary_${Date.now()}_${summaryIdCounter}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date(),
        summary,
        firstKeptMessageId,
        tokensBefore: estimateMessagesTokens(modelMessagesToSummarize),
        summaryTokens,
      };

      const totalTokensReplaced =
        summaryEntry.tokensBefore +
        this.summaries.reduce((sum, s) => sum + s.summaryTokens, 0);
      if (summaryEntry.summaryTokens >= totalTokensReplaced) {
        this._lastCompactionRejected = true;
        return false;
      }

      // Replace all previous summaries with the new one (iterative compaction)
      // The new summary already incorporates previous context via previousSummary parameter
      this.summaries = [summaryEntry];
      this.messages = messagesToKeep;
      this.ensureNoOrphanedToolResults();
      this.adjustActualUsageAfterReduction(
        summaryEntry.tokensBefore - summaryEntry.summaryTokens
      );
      this.touch();

      return true;
    } catch (error) {
      // Log error but don't throw to prevent breaking message flow
      console.error("Compaction failed:", error);
      return false;
    } finally {
      this.compactionInProgress = false;
    }
  }

  private enforceLimit(): void {
    if (this.messages.length <= this.maxMessages) {
      return;
    }

    if (this.maxMessages === 1) {
      const lastMessage = this.messages.at(-1);
      this.messages = lastMessage ? [lastMessage] : [];
      this.ensureNoOrphanedToolResults();
      return;
    }

    const turnBoundaries: number[] = [];
    for (let i = 1; i < this.messages.length; i++) {
      if (this.messages[i].modelMessage.role === "user") {
        turnBoundaries.push(i);
      }
    }

    if (turnBoundaries.length === 0) {
      this.messages = [
        this.messages[0],
        ...this.messages.slice(-(this.maxMessages - 1)),
      ];
      this.ensureNoOrphanedToolResults();
      return;
    }

    for (const boundary of turnBoundaries) {
      const keptCount = 1 + (this.messages.length - boundary);
      if (keptCount <= this.maxMessages) {
        this.messages = [this.messages[0], ...this.messages.slice(boundary)];
        return;
      }
    }

    const lastBoundary = turnBoundaries.at(-1);
    if (lastBoundary === undefined) {
      return;
    }
    const lastBoundaryCandidate = [
      this.messages[0],
      ...this.messages.slice(lastBoundary),
    ];

    if (lastBoundaryCandidate.length <= this.maxMessages) {
      this.messages = lastBoundaryCandidate;
      return;
    }

    this.messages = [
      this.messages[0],
      ...this.messages.slice(-(this.maxMessages - 1)),
    ];
    this.ensureNoOrphanedToolResults();
  }

  /**
   * Remove orphaned tool_result messages that lack a preceding tool_call.
   * Also removes assistant messages with tool-calls whose tool-results are missing.
   * Called after enforceLimit() and performCompaction() trim the message array.
   */
  private ensureNoOrphanedToolResults(): void {
    // Remove leading 'tool' messages (handles maxMessages=1 edge case)
    while (
      this.messages.length > 0 &&
      this.messages[0]?.modelMessage.role === "tool"
    ) {
      this.messages.shift();
    }

    // Remove 'tool' messages at subsequent positions that lack a preceding
    // 'assistant' message
    let i = 1;
    while (i < this.messages.length) {
      if (this.messages[i]?.modelMessage.role === "tool") {
        const prev = this.messages[i - 1];
        if (prev?.modelMessage.role !== "assistant") {
          this.messages.splice(i, 1);
          continue;
        }
      }
      i++;
    }

    // Remove assistant messages with tool-calls that have no following tool results
    this.removeOrphanedToolCalls();
  }

  /**
   * Remove assistant messages that contain tool-calls but have no
   * corresponding tool-result messages following them.
   * This prevents sending incomplete tool sequences to the LLM.
   */
  private removeOrphanedToolCalls(): void {
    let i = 0;
    while (i < this.messages.length) {
      const msg = this.messages[i];
      if (hasToolCalls(msg.modelMessage)) {
        // Check if next message(s) are tool results
        const nextIdx = i + 1;
        if (
          nextIdx >= this.messages.length ||
          this.messages[nextIdx].modelMessage.role !== "tool"
        ) {
          // Orphaned tool-call — remove it
          this.messages.splice(i, 1);
          continue;
        }
      }
      i++;
    }
  }

  private sanitizeMessage(message: ModelMessage): ModelMessage {
    if (message.role !== "tool") {
      return message;
    }

    if (!Array.isArray(message.content)) {
      return message;
    }

    const sanitizedContent = message.content.map((part) => {
      if (!isToolResultContentPart(part)) {
        return part;
      }

      const sanitizedOutput = this.serializeValue(part.output);

      if (sanitizedOutput === part.output) {
        return part;
      }

      return {
        ...part,
        output: sanitizedOutput as ToolResultPart["output"],
      };
    });

    return {
      ...message,
      content: sanitizedContent,
    };
  }

  private serializeValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (value instanceof Error) {
      return {
        __error: true,
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.serializeValue(item));
    }

    if (typeof value === "object" && value.constructor === Object) {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this.serializeValue(val);
      }
      return result;
    }

    return value;
  }

  toModelMessages(): ModelMessage[] {
    return this.messages.map((message) => message.modelMessage);
  }
}
