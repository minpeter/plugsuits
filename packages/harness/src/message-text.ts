import type { ModelMessage } from "ai";

export interface MessageTextOptions {
  joiner?: string;
  trim?: boolean;
}

interface TextMessagePart {
  text: string;
  type: "text";
}

function isTextMessagePart(part: unknown): part is TextMessagePart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

export function getMessageText(
  message: ModelMessage,
  options?: MessageTextOptions
): string {
  let text = "";

  if (typeof message.content === "string") {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    text = message.content
      .filter(isTextMessagePart)
      .map((part) => part.text)
      .join(options?.joiner ?? " ");
  }

  return options?.trim ? text.trim() : text;
}

export function getLastMessageText(
  messages: ModelMessage[],
  role: ModelMessage["role"],
  options?: MessageTextOptions
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== role) {
      continue;
    }

    const text = getMessageText(message, options);
    if (text) {
      return text;
    }
  }

  return "";
}

export function getLastUserText(
  messages: ModelMessage[],
  options?: MessageTextOptions
): string {
  return getLastMessageText(messages, "user", options);
}
