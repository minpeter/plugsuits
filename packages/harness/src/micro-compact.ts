import type { ModelMessage, TextPart } from "ai";
import type { CheckpointMessage } from "./compaction-types";
import { estimateTokens, extractMessageText } from "./token-utils";

const DEFAULT_PROTECT_RECENT_TOKENS = 2000;
const DEFAULT_MAX_RESPONSE_TOKENS = 500;
const DEFAULT_REPLACEMENT_TEMPLATE =
  "[response shrunk — {original_tokens} → {shrunk_tokens} tokens]";
const DEFAULT_MIN_SAVINGS_TOKENS = 100;
const SHRUNK_RESPONSE_RATIO = 0.3;

export interface MicroCompactOptions {
  maxResponseTokens?: number;
  minSavingsTokens?: number;
  protectRecentTokens?: number;
  replacementTemplate?: string;
}

export interface MicroCompactResult {
  messages: CheckpointMessage[];
  messagesModified: number;
  tokensSaved: number;
}

interface RewriteResult {
  originalTokens: number;
  rewritten: ModelMessage;
  shrunkTokens: number;
}

function isTextPart(part: unknown): part is TextPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function resolveProtectedFromIndex(
  messages: CheckpointMessage[],
  protectRecentTokens: number
): number {
  let protectedFromIndex = messages.length;
  let recentTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = estimateTokens(
      extractMessageText(messages[i].message)
    );
    if (recentTokens + messageTokens > protectRecentTokens) {
      protectedFromIndex = i + 1;
      break;
    }

    recentTokens += messageTokens;
    if (i === 0) {
      protectedFromIndex = 0;
    }
  }

  return protectedFromIndex;
}

function truncateToTokenLimit(text: string, tokenLimit: number): string {
  if (tokenLimit <= 0 || text.length === 0) {
    return "";
  }

  if (estimateTokens(text) <= tokenLimit) {
    return text;
  }

  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, mid);

    if (estimateTokens(candidate) <= tokenLimit) {
      low = mid;
      continue;
    }

    high = mid - 1;
  }

  return text.slice(0, low).trimEnd();
}

function renderReplacementText(
  template: string,
  originalTokens: number,
  shrunkTokens: number
): string {
  return template
    .replaceAll("{original_tokens}", String(originalTokens))
    .replaceAll("{shrunk_tokens}", String(shrunkTokens));
}

function buildShrunkText(
  originalText: string,
  maxResponseTokens: number,
  replacementTemplate: string,
  originalTokens: number
): { text: string; tokens: number } {
  const targetTokens = Math.max(
    0,
    Math.floor(maxResponseTokens * SHRUNK_RESPONSE_RATIO)
  );
  const truncatedText = truncateToTokenLimit(originalText, targetTokens);

  let shrunkTokens = 0;
  let shrunkText = "";

  for (let i = 0; i < 5; i++) {
    const replacement = renderReplacementText(
      replacementTemplate,
      originalTokens,
      shrunkTokens
    );
    const candidate =
      truncatedText.length > 0
        ? `${truncatedText}\n\n${replacement}`
        : replacement;
    const candidateTokens = estimateTokens(candidate);

    shrunkText = candidate;
    if (candidateTokens === shrunkTokens) {
      return { text: shrunkText, tokens: candidateTokens };
    }

    shrunkTokens = candidateTokens;
  }

  return { text: shrunkText, tokens: estimateTokens(shrunkText) };
}

function rewriteAssistantMessage(
  message: ModelMessage,
  maxResponseTokens: number,
  replacementTemplate: string
): RewriteResult | null {
  if (message.role !== "assistant") {
    return null;
  }

  if (typeof message.content === "string") {
    const originalTokens = estimateTokens(message.content);
    if (originalTokens <= maxResponseTokens) {
      return null;
    }

    const shrunk = buildShrunkText(
      message.content,
      maxResponseTokens,
      replacementTemplate,
      originalTokens
    );

    return {
      rewritten: {
        ...message,
        content: shrunk.text,
      },
      originalTokens,
      shrunkTokens: shrunk.tokens,
    };
  }

  if (!Array.isArray(message.content)) {
    return null;
  }

  const textParts = message.content.filter(isTextPart);
  if (textParts.length === 0 || textParts.length !== message.content.length) {
    return null;
  }

  const originalText = textParts.map((part) => part.text).join("\n");
  const originalTokens = estimateTokens(originalText);
  if (originalTokens <= maxResponseTokens) {
    return null;
  }

  const shrunk = buildShrunkText(
    originalText,
    maxResponseTokens,
    replacementTemplate,
    originalTokens
  );
  const rewrittenTextPart: TextPart = {
    ...textParts[0],
    text: shrunk.text,
  };

  return {
    rewritten: {
      ...message,
      content: [rewrittenTextPart],
    },
    originalTokens,
    shrunkTokens: shrunk.tokens,
  };
}

export function microCompactMessages(
  messages: CheckpointMessage[],
  options: MicroCompactOptions = {}
): MicroCompactResult {
  if (messages.length === 0) {
    return { messages: [], tokensSaved: 0, messagesModified: 0 };
  }

  const protectRecentTokens = Math.max(
    0,
    options.protectRecentTokens ?? DEFAULT_PROTECT_RECENT_TOKENS
  );
  const maxResponseTokens = Math.max(
    0,
    options.maxResponseTokens ?? DEFAULT_MAX_RESPONSE_TOKENS
  );
  const replacementTemplate =
    options.replacementTemplate ?? DEFAULT_REPLACEMENT_TEMPLATE;
  const minSavingsTokens = Math.max(
    0,
    options.minSavingsTokens ?? DEFAULT_MIN_SAVINGS_TOKENS
  );

  const protectedFromIndex = resolveProtectedFromIndex(
    messages,
    protectRecentTokens
  );

  const resultMessages = [...messages];
  let tokensSaved = 0;
  let messagesModified = 0;

  for (let i = 0; i < messages.length; i++) {
    const checkpointMessage = messages[i];

    if (i >= protectedFromIndex) {
      continue;
    }

    if (checkpointMessage.isSummary === true) {
      continue;
    }

    if (checkpointMessage.message.role !== "assistant") {
      continue;
    }

    const rewrite = rewriteAssistantMessage(
      checkpointMessage.message,
      maxResponseTokens,
      replacementTemplate
    );

    if (!rewrite) {
      continue;
    }

    const savedTokens = rewrite.originalTokens - rewrite.shrunkTokens;
    if (savedTokens < minSavingsTokens) {
      continue;
    }

    resultMessages[i] = {
      ...checkpointMessage,
      message: rewrite.rewritten,
    };

    tokensSaved += savedTokens;
    messagesModified += 1;
  }

  return {
    messages: resultMessages,
    tokensSaved,
    messagesModified,
  };
}
