import type { ModelMessage, TextPart, ToolResultPart } from "ai";

const TRAILING_NEWLINES = /\n+$/;

// Constants for token estimation and compaction
const CHARS_PER_TOKEN = 4;
const MAX_TEXT_LENGTH_PER_MESSAGE = 500;
const SUMMARY_PREFIX = "Previous conversation summary:";
const SYSTEM_CONTEXT_PREFIX = "Previous conversation context:";

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
 * Simple token estimator based on character count.
 * Uses a conservative estimate of ~4 characters per token.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
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
   * If not provided, a simple concatenation fallback is used.
   */
  summarizeFn?: (messages: ModelMessage[]) => Promise<string>;
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
 * Default summarizer that concatenates message content.
 * This is a fallback when no custom summarizer is provided.
 * Output is sanitized to prevent prompt injection.
 */
async function defaultSummarizeFn(messages: ModelMessage[]): Promise<string> {
  const parts = messages.map((msg) => {
    const role = msg.role;
    const text = extractMessageText(msg);
    const truncated = text.slice(0, MAX_TEXT_LENGTH_PER_MESSAGE);
    const suffix = text.length > MAX_TEXT_LENGTH_PER_MESSAGE ? "..." : "";
    // Sanitize each part to prevent injection through message content
    const sanitizedRole = sanitizeSummaryText(role);
    const sanitizedContent = sanitizeSummaryText(truncated + suffix);
    return `[${sanitizedRole}]: ${sanitizedContent}`;
  });
  const summary = `${SUMMARY_PREFIX}\n${parts.join("\n")}`;
  return sanitizeSummaryText(summary);
}

export class MessageHistory {
  private messages: Message[] = [];
  private readonly maxMessages: number;
  private readonly compaction: CompactionConfig;
  private summaries: CompactionSummary[] = [];
  private compactionInProgress = false;

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
   * Trigger compaction manually. Returns true if compaction was performed.
   */
  async compact(): Promise<boolean> {
    if (!this.compaction.enabled || this.messages.length === 0) {
      return false;
    }

    // Prevent concurrent compaction (race condition fix)
    if (this.compactionInProgress) {
      return false;
    }

    return this.performCompaction();
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
    // Trigger compaction asynchronously, errors are handled internally
    this.checkAndCompact().catch((error) => {
      console.error("Compaction error in addUserMessage:", error);
    });
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
    // Trigger compaction asynchronously, errors are handled internally
    this.checkAndCompact().catch((error) => {
      console.error("Compaction error in addModelMessages:", error);
    });
    return created;
  }

  /**
   * Get messages with compaction summaries prepended as system context.
   * This is the recommended way to get messages for LLM calls when
   * compaction is enabled.
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

  private async checkAndCompact(): Promise<void> {
    if (!this.compaction.enabled || this.compactionInProgress) {
      return;
    }

    const totalTokens = this.getEstimatedTokens();
    const threshold =
      (this.compaction.maxTokens ?? DEFAULT_COMPACTION_MAX_TOKENS) -
      (this.compaction.reserveTokens ?? DEFAULT_COMPACTION_RESERVE);

    if (totalTokens < threshold) {
      return;
    }

    try {
      await this.performCompaction();
    } catch (error) {
      // Log error but don't throw to prevent breaking message flow
      console.error("Auto-compaction failed:", error);
    }
  }

  private async performCompaction(): Promise<boolean> {
    if (this.messages.length === 0) {
      return false;
    }

    this.compactionInProgress = true;

    try {
      // Calculate tokens from the end to find what to keep
      // KeepRecentTokens 범위 내 메시지는 요약되지 않고 보존
      const keepRecentTokens =
        this.compaction.keepRecentTokens ?? DEFAULT_COMPACTION_KEEP_RECENT;

      let keptTokens = 0;  // 뒤에서부터 누적된 보존 대상 토큰 수
      let splitIndex = this.messages.length;  // 분할 지점 (기본값: 모두 보존)

      // Walk backwards to find where to split
      // Logic: 뒤에서부터 순회하며 keepRecentTokens를 초과하지 않는 범위를 찾음
      // - splitIndex 이후 (splitIndex + 1 ~ end): 보존 대상 (요약되지 않음)
      // - splitIndex 이전 (0 ~ splitIndex - 1): 요약 대상
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokens(
          extractMessageText(this.messages[i].modelMessage)
        );

        // 현재 메시지까지 포함하면 keepRecentTokens를 초과하는 경우
        // 현재 메시지(i)는 요약 대상, i+1부터는 보존 대상
        if (keptTokens + msgTokens > keepRecentTokens) {
          splitIndex = i + 1;  // i+1부터 끝까지 보존
          break;
        }

        // 현재 메시지를 보존 대상에 포함
        keptTokens += msgTokens;

        // Always keep at least the last turn (처음까지 도달하면 모두 보존)
        if (i === 0) {
          splitIndex = 0;  // 모든 메시지 보존, 요약 없음
        }
      }

      // Ensure at least one message is kept (empty messages bug fix)
      if (splitIndex === 0) {
        splitIndex = 1;
      }

      // If all messages would be kept, nothing to compact
      if (splitIndex >= this.messages.length) {
        return false;
      }

      // Messages to summarize (splitIndex 이전 메시지들)
      const messagesToSummarize = this.messages.slice(0, splitIndex);
      // Messages to keep as-is (splitIndex부터 끝까지)
      const messagesToKeep = this.messages.slice(splitIndex);

      if (messagesToSummarize.length === 0) {
        return false;
      }

      // Get the first kept message ID
      const firstKeptMessageId =
        messagesToKeep.length > 0 ? messagesToKeep[0].id : "end";

      // Summarize with error handling and fallback
      const summarizeFn = this.compaction.summarizeFn ?? defaultSummarizeFn;
      const modelMessagesToSummarize = messagesToSummarize.map(
        (m) => m.modelMessage
      );

      let summary: string;
      try {
        summary = await summarizeFn(modelMessagesToSummarize);
      } catch (error) {
        // Fallback to default summarizer if custom one fails
        console.warn("Custom summarizeFn failed, using fallback:", error);
        summary = await defaultSummarizeFn(modelMessagesToSummarize);
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

      this.summaries.push(summaryEntry);
      this.messages = messagesToKeep;

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
