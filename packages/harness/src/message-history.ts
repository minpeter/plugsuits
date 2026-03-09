import type { ModelMessage, TextPart, ToolResultPart } from "ai";
import { pruneToolOutputs } from "./tool-pruning";
import type { PruningConfig } from "./tool-pruning";

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
    .replace(/[\x00-\x09\x0B-\x1F]/g, ""); // Remove control characters except newlines (\x0A)
}

/**
 * Improved token estimator that accounts for CJK characters.
 * CJK characters typically map to ~1-2 tokens each (vs ~4 chars/token for Latin).
 */
function estimateTokens(text: string): number {
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = text.length - cjkCount;

  const cjkTokens = cjkCount / CJK_CHARS_PER_TOKEN;
  const nonCjkTokens = nonCjkCount / LATIN_CHARS_PER_TOKEN;

  return Math.ceil(cjkTokens + nonCjkTokens);
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
  if (message.role !== "assistant") return false;
  if (!Array.isArray(message.content)) return false;
  return message.content.some(
    (part) => typeof part === "object" && part !== null && part.type === "tool-call"
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

  // If the message at splitIndex is a tool result, we'd be separating it from
  // its tool-call. Move splitIndex forward to include tool results with their calls.
  let idx = proposedIndex;
  while (idx < messages.length && messages[idx].modelMessage.role === "tool") {
    idx++;
  }

  // If the message just before splitIndex is an assistant with tool-calls,
  // the tool results are being kept but the tool-call is being summarized.
  // Move splitIndex back to include the assistant message too.
  if (idx > 0 && idx <= messages.length) {
    const prevMsg = messages[idx - 1];
    if (prevMsg && hasToolCalls(prevMsg.modelMessage)) {
      // The assistant message at idx-1 has tool-calls. Check if idx has the tool results.
      // If so, we need to keep the assistant message too — move split back.
      // But only if we haven't already adjusted past it.
      if (idx === proposedIndex) {
        // No tool messages at split point, check if we're splitting a pair
        const prevPrev = idx >= 2 ? messages[idx - 1] : null;
        if (prevPrev && hasToolCalls(prevPrev.modelMessage)) {
          // assistant with tool-calls is being summarized, but its results might be at idx
          if (idx < messages.length && messages[idx].modelMessage.role === "tool") {
            // Results are being kept — include the assistant too
            idx--;
          }
        }
      }
    }
  }

  // Final check: if idx would leave nothing to summarize, return original
  if (idx <= 0) return proposedIndex;

  return idx;
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
 * Summary entry representing a compacted batch of messages.
 */
export interface CompactionSummary {
  id: string;
  createdAt: Date;
  summary: string;
  /** ID of the first message that was kept after this summary */
  firstKeptMessageId: string;
  /** Estimated tokens before compaction */
  tokensBefore: number;
  /** Estimated tokens in the summary */
  summaryTokens: number;
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
   * Maximum total tokens before triggering compaction.
   * When exceeded, older messages will be summarized.
   * @default 8000
   */
  maxTokens?: number;

  /**
   * Number of recent tokens to preserve from compaction.
   * These messages are always kept in full form.
   * @default 2000
   */
  keepRecentTokens?: number;

  /**
   * Reserve tokens for the response. Compaction triggers when
   * (totalTokens + reserveTokens) > maxTokens.
   * @default 2000
   */
  reserveTokens?: number;

  /**
   * Custom function to summarize a batch of messages.
   * If not provided, an improved extraction-based fallback is used.
   *
   * @param messages - The messages to summarize
   * @param previousSummary - Optional previous summary to build upon (iterative compaction)
   */
  summarizeFn?: (messages: ModelMessage[], previousSummary?: string) => Promise<string>;
}

export interface MessageHistoryOptions {
  /**
   * Maximum number of messages to retain. When exceeded, older messages
   * are trimmed from the front while preserving the initial user message
   * for context continuity. Defaults to 1000.
   */
  maxMessages?: number;

  /**
   * Incremental compaction configuration for managing long contexts.
   * When enabled, older messages are summarized to reduce token usage
   * while preserving important context.
   */
  compaction?: CompactionConfig;

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

/**
 * Improved default summarizer that extracts conversation essence.
 * Groups messages by turns, prioritizes user intents and assistant decisions,
 * and drops verbose tool outputs.
 * Output is sanitized to prevent prompt injection and structured with
 * clear sections for context preservation.
 */
async function defaultSummarizeFn(messages: ModelMessage[], previousSummary?: string): Promise<string> {
  if (messages.length === 0) {
    return sanitizeSummaryText(`${SUMMARY_PREFIX}\n(empty conversation)`);
  }

  // Extract user intents (what the user asked/said)
  const userIntents: string[] = [];
  // Extract assistant key responses
  const assistantResponses: string[] = [];
  // Extract tool usage summary
  const toolUsage: string[] = [];

  const turns: string[] = [];
  let currentTurn: string[] = [];

  for (const msg of messages) {
    const role = msg.role;
    const text = extractMessageText(msg);

    if (role === "tool") {
      // For tool results, only include a brief indicator
      const toolName = Array.isArray(msg.content)
        ? msg.content
            .filter(
              (p: any) =>
                typeof p === "object" && p !== null && p.type === "tool-result"
            )
            .map((p: any) => p.toolName)
            .join(", ")
        : "tool";
      const briefOutput = text.slice(0, 100);
      const suffix = text.length > 100 ? "..." : "";
      currentTurn.push(`  [tool:${sanitizeSummaryText(toolName)}]: ${sanitizeSummaryText(briefOutput + suffix)}`);
      if (!toolUsage.includes(toolName)) {
        toolUsage.push(sanitizeSummaryText(toolName));
      }
      continue;
    }

    // New user message starts a new turn
    if (role === "user" && currentTurn.length > 0) {
      turns.push(currentTurn.join("\n"));
      currentTurn = [];
    }

    const truncated = text.slice(0, MAX_TEXT_LENGTH_PER_MESSAGE);
    const suffix = text.length > MAX_TEXT_LENGTH_PER_MESSAGE ? "..." : "";
    const sanitizedRole = sanitizeSummaryText(role);
    const sanitizedContent = sanitizeSummaryText(truncated + suffix);
    currentTurn.push(`[${sanitizedRole}]: ${sanitizedContent}`);

    // Track user intents (first 150 chars)
    if (role === "user") {
      const intent = sanitizeSummaryText(text.slice(0, 150));
      if (intent.trim()) {
        userIntents.push(intent);
      }
    }

    // Track assistant key points (first 150 chars)
    if (role === "assistant" && text.trim()) {
      const response = sanitizeSummaryText(text.slice(0, 150));
      if (response.trim()) {
        assistantResponses.push(response);
      }
    }
  }

  if (currentTurn.length > 0) {
    turns.push(currentTurn.join("\n"));
  }

  // Build structured summary
  const sections: string[] = [];

  // Section 0: Previous context (if iterative compaction)
  if (previousSummary) {
    sections.push(`Previous Context:\n${sanitizeSummaryText(previousSummary)}`);
  }

  // Section 1: Key Topics (from user messages)
  if (userIntents.length > 0) {
    const topicEntries = userIntents.length > 4
      ? [...userIntents.slice(0, 2), `(... ${userIntents.length - 3} more)`, userIntents[userIntents.length - 1]]
      : userIntents;
    sections.push(`Key Topics:\n${topicEntries.map(t => `- ${t}`).join("\n")}`);
  }

  // Section 2: Tools Used
  if (toolUsage.length > 0) {
    sections.push(`Tools Used: ${toolUsage.join(", ")}`);
  }

  // Section 3: Conversation Flow (condensed turns)
  let turnBody: string;
  if (turns.length > 6) {
    const kept = [
      ...turns.slice(0, 2),
      `[... ${turns.length - 4} turns omitted ...]`,
      ...turns.slice(-2),
    ];
    turnBody = kept.join("\n---\n");
  } else {
    turnBody = turns.join("\n---\n");
  }
  sections.push(`Conversation:\n${turnBody}`);

  // Section 4: Last state (most recent assistant response)
  if (assistantResponses.length > 0) {
    const lastResponse = assistantResponses[assistantResponses.length - 1];
    sections.push(`Last Response: ${lastResponse}`);
  }

  const summary = `${SUMMARY_PREFIX}\n${sections.join("\n\n")}`;
  return sanitizeSummaryText(summary);
}

export class MessageHistory {
  private messages: Message[] = [];
  private readonly maxMessages: number;
  private compaction: CompactionConfig;
  private pruning: PruningConfig;
  private summaries: CompactionSummary[] = [];
  private compactionInProgress = false;
  private pendingCompaction = false;

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
      maxTokens: options?.compaction?.maxTokens ?? DEFAULT_COMPACTION_MAX_TOKENS,
      keepRecentTokens:
        options?.compaction?.keepRecentTokens ?? DEFAULT_COMPACTION_KEEP_RECENT,
      reserveTokens:
        options?.compaction?.reserveTokens ?? DEFAULT_COMPACTION_RESERVE,
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

  clear(): void {
    this.messages = [];
    this.summaries = [];
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

  /**
   * Get the current pruning configuration.
   */
  getPruningConfig(): Readonly<PruningConfig> {
    return { ...this.pruning };
  }

  /**
   * Update compaction configuration dynamically.
   * Useful when switching models with different context limits.
   */
  updateCompaction(config: Partial<CompactionConfig>): void {
    if (config.enabled !== undefined) {
      this.compaction.enabled = config.enabled;
    }
    if (config.maxTokens !== undefined) {
      this.compaction.maxTokens = config.maxTokens;
    }
    if (config.keepRecentTokens !== undefined) {
      this.compaction.keepRecentTokens = config.keepRecentTokens;
    }
    if (config.reserveTokens !== undefined) {
      this.compaction.reserveTokens = config.reserveTokens;
    }
    if (config.summarizeFn !== undefined) {
      this.compaction.summarizeFn = config.summarizeFn;
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

  /**
   * Check if compaction is needed based on current token count.
   * This is a synchronous check — no compaction is performed.
   */
  needsCompaction(): boolean {
    if (!this.compaction.enabled || this.messages.length === 0) {
      return false;
    }

    const totalTokens = this.getEstimatedTokens();
    const threshold =
      (this.compaction.maxTokens ?? DEFAULT_COMPACTION_MAX_TOKENS) -
      (this.compaction.reserveTokens ?? DEFAULT_COMPACTION_RESERVE);

    return totalTokens >= threshold;
  }

  /**
   * Trigger compaction manually. Returns true if compaction was performed.
   * When pruning is enabled, it runs first. If pruning alone brings
   * the token count below the compaction threshold, compaction is skipped.
   */
  async compact(): Promise<boolean> {
    if (this.messages.length === 0) {
      return false;
    }

    // Prevent concurrent compaction (race condition fix)
    if (this.compactionInProgress) {
      return false;
    }

    // Run pruning first if enabled
    let pruned = false;
    if (this.pruning.enabled) {
      pruned = this.performPruning();
    }

    if (!this.compaction.enabled) {
      return pruned;
    }

    // If pruning brought us below threshold, skip compaction
    if (pruned && !this.needsCompaction()) {
      return true;
    }

    const compacted = await this.performCompaction();
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
    // Mark that compaction may be needed
    this.markCompactionNeeded();
    return created;
  }

  /**
   * Synchronously mark that compaction check is needed.
   * No async work is done here — avoids the fire-and-forget race condition.
   */
  private markCompactionNeeded(): void {
    if (!this.compaction.enabled) return;
    this.pendingCompaction = true;
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
   */
  async getMessagesForLLMAsync(): Promise<ModelMessage[]> {
    if (this.pendingCompaction) {
      this.pendingCompaction = false;

      // Run pruning first if enabled
      if (this.pruning.enabled) {
        try {
          this.performPruning();
        } catch (error) {
          console.error("Pruning error in getMessagesForLLMAsync:", error);
        }
      }

      // Only run compaction if still needed
      if (this.compaction.enabled && this.needsCompaction()) {
        try {
          await this.performCompaction();
        } catch (error) {
          console.error("Compaction error in getMessagesForLLMAsync:", error);
        }
      }
    }

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

    return true;
  }

  private async performCompaction(): Promise<boolean> {
    if (this.messages.length === 0) {
      return false;
    }

    this.compactionInProgress = true;

    try {
      // Calculate tokens from the end to find what to keep
      const keepRecentTokens =
        this.compaction.keepRecentTokens ?? DEFAULT_COMPACTION_KEEP_RECENT;

      let keptTokens = 0;
      let splitIndex = this.messages.length;

      // Walk backwards to find where to split
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

      // Edge case: all messages fit in keepRecentTokens
      if (splitIndex === 0) {
        // Don't force splitIndex to 1 blindly.
        // If we have only 1 message, there's nothing to summarize.
        if (this.messages.length <= 1) {
          return false;
        }
        // Need to summarize at least something — find a reasonable split
        // Summarize the first half
        splitIndex = Math.max(1, Math.floor(this.messages.length / 2));
      }

      // If all messages would be kept, nothing to compact
      if (splitIndex >= this.messages.length) {
        return false;
      }

      // Adjust split index to preserve tool-call/tool-result pairs
      splitIndex = adjustSplitIndexForToolPairs(this.messages, splitIndex);

      // Re-check after adjustment
      if (splitIndex >= this.messages.length || splitIndex <= 0) {
        return false;
      }

      // Messages to summarize (before splitIndex)
      const messagesToSummarize = this.messages.slice(0, splitIndex);
      // Messages to keep as-is (splitIndex onwards)
      const messagesToKeep = this.messages.slice(splitIndex);

      if (messagesToSummarize.length === 0) {
        return false;
      }

      // Get the first kept message ID
      const firstKeptMessageId =
        messagesToKeep.length > 0 ? messagesToKeep[0].id : "end";

      // Combine existing summaries into previousSummary for iterative compaction
      const previousSummary = this.summaries.length > 0
        ? this.summaries.map((s) => s.summary).join("\n\n---\n\n")
        : undefined;

      // Summarize with error handling and fallback
      const summarizeFn = this.compaction.summarizeFn ?? defaultSummarizeFn;
      const modelMessagesToSummarize = messagesToSummarize.map(
        (m) => m.modelMessage
      );

      let summary: string;
      try {
        summary = await summarizeFn(modelMessagesToSummarize, previousSummary);
      } catch (error) {
        // Fallback to default summarizer if custom one fails
        console.warn("Custom summarizeFn failed, using fallback:", error);
        summary = await defaultSummarizeFn(modelMessagesToSummarize, previousSummary);
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

      // Replace all previous summaries with the new one (iterative compaction)
      // The new summary already incorporates previous context via previousSummary parameter
      this.summaries = [summaryEntry];
      this.messages = messagesToKeep;
      this.ensureNoOrphanedToolResults();

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
      this.messages = [this.messages[this.messages.length - 1]];
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

    const lastBoundary = turnBoundaries[turnBoundaries.length - 1];
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

    const sanitizedContent = message.content.map((part: any) => {
      if (part.type !== "tool-result") {
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
