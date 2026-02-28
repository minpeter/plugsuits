import type { ModelMessage, TextPart } from "ai";

const TRAILING_NEWLINES = /\n+$/;

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

export interface MessageHistoryOptions {
  /**
   * Maximum number of messages to retain. When exceeded, older messages
   * are trimmed from the front while preserving the initial user message
   * for context continuity. Defaults to 1000.
   */
  maxMessages?: number;
}

const createMessageId = (() => {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `msg_${counter}`;
  };
})();

const DEFAULT_MAX_MESSAGES = 1000;

export class MessageHistory {
  private messages: Message[] = [];
  private readonly maxMessages: number;

  constructor(options?: MessageHistoryOptions) {
    const max = options?.maxMessages ?? DEFAULT_MAX_MESSAGES;
    if (!Number.isFinite(max) || max < 1 || max !== Math.floor(max)) {
      throw new RangeError(
        `maxMessages must be a positive integer >= 1, got ${max}`
      );
    }
    this.maxMessages = max;
  }

  getAll(): Message[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
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
    return created;
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

      const result = part as unknown as {
        type: "tool-result";
        output: unknown;
        [key: string]: unknown;
      };

      const sanitizedOutput = this.serializeValue(result.output);

      if (sanitizedOutput === result.output) {
        return part;
      }

      return {
        ...result,
        output: sanitizedOutput,
      };
    });

    return {
      ...message,
      content: sanitizedContent as typeof message.content,
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
