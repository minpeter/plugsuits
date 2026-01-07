import type { ModelMessage } from "ai";

export interface Message {
  id: string;
  createdAt: Date;
  modelMessage: ModelMessage;
}

const createMessageId = (() => {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `msg_${counter}`;
  };
})();

export class MessageHistory {
  private messages: Message[] = [];

  getAll(): Message[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
  }

  addUserMessage(content: string): Message {
    const message: Message = {
      id: createMessageId(),
      createdAt: new Date(),
      modelMessage: {
        role: "user",
        content,
      },
    };
    this.messages.push(message);
    return message;
  }

  addModelMessages(messages: ModelMessage[]): Message[] {
    const created: Message[] = [];
    for (const modelMessage of messages) {
      const message: Message = {
        id: createMessageId(),
        createdAt: new Date(),
        modelMessage,
      };
      created.push(message);
    }
    this.messages.push(...created);
    return created;
  }

  toModelMessages(): ModelMessage[] {
    return this.messages.map((message) => message.modelMessage);
  }
}
