import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { calculateCompactionSplitIndex } from "./compaction-planner";
import type {
  CheckpointMessage,
  CompactionConfig,
  CompactionResult,
  MessageLine,
  PruningConfig,
} from "./compaction-types";
import type { SessionStore } from "./session-store";
import { estimateTokens, extractMessageText } from "./token-utils";

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

function hasToolCalls(message: ModelMessage): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return false;
  }

  return message.content.some(
    (part) =>
      typeof part === "object" && part !== null && part.type === "tool-call"
  );
}

export class CheckpointHistory {
  private messages: CheckpointMessage[] = [];
  private summaryMessageId: string | null = null;
  private revision = 0;
  private readonly sessionId: string;
  private readonly sessionStore: SessionStore | null;
  private readonly compactionConfig: NormalizedCompactionConfig;
  private readonly pruningConfig: Required<PruningConfig>;

  constructor(options?: CheckpointHistoryOptions) {
    this.sessionId = options?.sessionId ?? randomUUID();
    this.sessionStore = options?.sessionStore ?? null;
    this.compactionConfig = {
      ...DEFAULT_COMPACTION_CONFIG,
      ...options?.compaction,
    };
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

  async compact(_options?: { auto?: boolean }): Promise<CompactionResult> {
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

    let splitIndex = calculateCompactionSplitIndex({
      adjustSplitIndex: (index) => index,
      aggressive: false,
      estimateMessageTokens: (message: CheckpointMessage) =>
        estimateTokens(extractMessageText(message.message)),
      keepRecentTokens: this.compactionConfig.keepRecentTokens ?? 2000,
      messages: activeMessages,
    });

    if (splitIndex === null) {
      splitIndex = calculateCompactionSplitIndex({
        adjustSplitIndex: (index) => index,
        aggressive: true,
        estimateMessageTokens: (message: CheckpointMessage) =>
          estimateTokens(extractMessageText(message.message)),
        keepRecentTokens: this.compactionConfig.keepRecentTokens ?? 2000,
        messages: activeMessages,
      });
    }

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

    if (toSummarize.length === 0) {
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
      toSummarize.map((message) => message.message),
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
      message: {
        role: "assistant",
        content: summaryText,
      },
    };

    const insertIndex = activeStartIndex + splitIndex;
    this.messages.splice(insertIndex, 0, summaryMessage);
    this.summaryMessageId = summaryMessage.id;
    this.revision += 1;

    if (this.sessionStore) {
      const line: MessageLine = {
        type: "message",
        id: summaryMessage.id,
        createdAt: summaryMessage.createdAt,
        isSummary: true,
        message: summaryMessage.message,
      };

      await this.sessionStore.appendMessage(this.sessionId, line);
      await this.sessionStore.updateCheckpoint(
        this.sessionId,
        summaryMessage.id
      );
    }

    const tokensAfter = this.getEstimatedTokens();
    return {
      success: true,
      summaryMessageId: summaryMessage.id,
      tokensBefore,
      tokensAfter,
    };
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

  private createCheckpointMessage(
    message: ModelMessage,
    originalContent?: string
  ): CheckpointMessage {
    return {
      id: randomUUID(),
      createdAt: Date.now(),
      isSummary: false,
      originalContent,
      message,
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
