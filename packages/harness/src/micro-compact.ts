import type { ModelMessage, TextPart } from "ai";
import type { CheckpointMessage } from "./compaction-types";
import { estimateTokens, extractMessageText } from "./token-utils";

const DEFAULT_PROTECT_RECENT_TOKENS = 2000;
const DEFAULT_MAX_RESPONSE_TOKENS = 500;
const DEFAULT_REPLACEMENT_TEMPLATE =
  "[response shrunk — {original_tokens} → {shrunk_tokens} tokens]";
const DEFAULT_MIN_SAVINGS_TOKENS = 100;
const DEFAULT_TOOL_RESULT_REPLACEMENT_TEXT = "[tool result cleared]";
const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 3;
const SHRUNK_RESPONSE_RATIO = 0.3;

export interface MicroCompactOptions {
  clearableToolNames?: string[];
  clearOlderThanMs?: number;
  clearToolResults?: boolean;
  keepRecentToolResults?: number;
  maxResponseTokens?: number;
  minSavingsTokens?: number;
  protectRecentTokens?: number;
  replacementTemplate?: string;
  toolResultReplacementText?: string;
}

export interface MicroCompactResult {
  messages: CheckpointMessage[];
  messagesModified: number;
  tokensSaved: number;
  toolResultsCleared: number;
}

interface RewriteResult {
  originalTokens: number;
  rewritten: ModelMessage;
  shrunkTokens: number;
}

interface ToolResultPart {
  content: unknown;
  name?: string;
  tool_name?: string;
  tool_use_id: string;
  toolName?: string;
  type: "tool_result";
}

interface ToolResultRef {
  messageIndex: number;
  partIndex: number;
}

interface AssistantCompactionResult {
  messages: CheckpointMessage[];
  modifiedMessageIndexes: Set<number>;
  tokensSaved: number;
}

interface ToolResultClearConfig {
  clearableToolNames: Set<string> | null;
  clearOlderThanTimestamp: number | null;
  keepRecentToolResults: number;
  replacementText: string;
}

interface ToolResultClearResult {
  messages: CheckpointMessage[];
  modifiedMessageIndexes: Set<number>;
  tokensSaved: number;
  toolResultsCleared: number;
}

interface ToolResultRewrite {
  nextContent: unknown[];
  tokensSaved: number;
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

function isToolResultPart(part: unknown): part is ToolResultPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "tool_result" &&
    "tool_use_id" in part &&
    typeof part.tool_use_id === "string" &&
    "content" in part
  );
}

function extractToolName(part: ToolResultPart): string | null {
  if (typeof part.tool_name === "string") {
    return part.tool_name;
  }

  if (typeof part.toolName === "string") {
    return part.toolName;
  }

  if (typeof part.name === "string") {
    return part.name;
  }

  return null;
}

function stringifyUnknownContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (content === undefined) {
    return "";
  }

  try {
    const stringified = JSON.stringify(content);
    if (typeof stringified === "string") {
      return stringified;
    }
  } catch {
    return String(content);
  }

  return String(content);
}

function estimateUnknownContentTokens(content: unknown): number {
  return estimateTokens(stringifyUnknownContent(content));
}

function collectToolResultRefs(
  messages: CheckpointMessage[],
  protectedFromIndex: number,
  clearableToolNames: Set<string> | null
): ToolResultRef[] {
  const refs: ToolResultRef[] = [];

  for (
    let messageIndex = 0;
    messageIndex < protectedFromIndex;
    messageIndex++
  ) {
    const checkpointMessage = messages[messageIndex];
    if (checkpointMessage.isSummary === true) {
      continue;
    }

    const modelMessage = checkpointMessage.message;
    if (modelMessage.role !== "user" || !Array.isArray(modelMessage.content)) {
      continue;
    }

    for (
      let partIndex = 0;
      partIndex < modelMessage.content.length;
      partIndex++
    ) {
      const part = modelMessage.content[partIndex];
      if (!isToolResultPart(part)) {
        continue;
      }

      if (clearableToolNames) {
        const toolName = extractToolName(part);
        if (toolName === null || !clearableToolNames.has(toolName)) {
          continue;
        }
      }

      refs.push({ messageIndex, partIndex });
    }
  }

  return refs;
}

function applyAssistantTextCompaction(
  messages: CheckpointMessage[],
  protectedFromIndex: number,
  maxResponseTokens: number,
  replacementTemplate: string,
  minSavingsTokens: number
): AssistantCompactionResult {
  const resultMessages = [...messages];
  const modifiedMessageIndexes = new Set<number>();
  let tokensSaved = 0;

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
    modifiedMessageIndexes.add(i);
    tokensSaved += savedTokens;
  }

  return {
    messages: resultMessages,
    modifiedMessageIndexes,
    tokensSaved,
  };
}

function applyToolResultClearing(
  messages: CheckpointMessage[],
  config: ToolResultClearConfig
): ToolResultClearResult {
  const hasTimeTrigger = config.clearOlderThanTimestamp !== null;
  const toolResultRefs = collectToolResultRefs(
    messages,
    messages.length,
    config.clearableToolNames
  );
  const clearUntil = Math.max(
    0,
    toolResultRefs.length - config.keepRecentToolResults
  );
  if (clearUntil === 0 && !hasTimeTrigger) {
    return {
      messages,
      modifiedMessageIndexes: new Set<number>(),
      tokensSaved: 0,
      toolResultsCleared: 0,
    };
  }

  const replacementTokens = estimateTokens(config.replacementText);
  const rewrittenContentByMessage = new Map<number, unknown[]>();
  let tokensSaved = 0;
  let toolResultsCleared = 0;

  for (let refIndex = 0; refIndex < toolResultRefs.length; refIndex++) {
    const ref = toolResultRefs[refIndex];
    const checkpointMessage = messages[ref.messageIndex];
    if (
      !isToolResultRefEligibleForClearing({
        checkpointMessage,
        clearOlderThanTimestamp: config.clearOlderThanTimestamp,
        clearUntil,
        refIndex,
      })
    ) {
      continue;
    }

    const rewrite = rewriteToolResult({
      checkpointMessage,
      existingContent: rewrittenContentByMessage.get(ref.messageIndex),
      partIndex: ref.partIndex,
      replacementText: config.replacementText,
      replacementTokens,
    });
    if (!rewrite) {
      continue;
    }

    tokensSaved += rewrite.tokensSaved;
    rewrittenContentByMessage.set(ref.messageIndex, rewrite.nextContent);
    toolResultsCleared += 1;
  }

  if (rewrittenContentByMessage.size === 0) {
    return {
      messages,
      modifiedMessageIndexes: new Set<number>(),
      tokensSaved: 0,
      toolResultsCleared: 0,
    };
  }

  const resultMessages = [...messages];
  const modifiedMessageIndexes = new Set<number>();

  for (const [messageIndex, rewrittenContent] of rewrittenContentByMessage) {
    const checkpointMessage = resultMessages[messageIndex];
    if (!checkpointMessage) {
      continue;
    }

    resultMessages[messageIndex] = {
      ...checkpointMessage,
      message: {
        ...checkpointMessage.message,
        content: rewrittenContent,
      } as unknown as ModelMessage,
    };
    modifiedMessageIndexes.add(messageIndex);
  }

  return {
    messages: resultMessages,
    modifiedMessageIndexes,
    tokensSaved,
    toolResultsCleared,
  };
}

function isToolResultRefEligibleForClearing(params: {
  checkpointMessage: CheckpointMessage | undefined;
  clearOlderThanTimestamp: number | null;
  clearUntil: number;
  refIndex: number;
}): params is {
  checkpointMessage: CheckpointMessage;
  clearOlderThanTimestamp: number | null;
  clearUntil: number;
  refIndex: number;
} {
  const { checkpointMessage, clearOlderThanTimestamp, clearUntil, refIndex } =
    params;

  if (!checkpointMessage) {
    return false;
  }

  if (refIndex < clearUntil) {
    return true;
  }

  return (
    clearOlderThanTimestamp !== null &&
    checkpointMessage.createdAt < clearOlderThanTimestamp
  );
}

function rewriteToolResult(params: {
  checkpointMessage: CheckpointMessage;
  existingContent: unknown[] | undefined;
  partIndex: number;
  replacementText: string;
  replacementTokens: number;
}): ToolResultRewrite | null {
  const {
    checkpointMessage,
    existingContent,
    partIndex,
    replacementText,
    replacementTokens,
  } = params;
  const checkpointContent = checkpointMessage.message.content as unknown;
  const baseContent =
    existingContent ??
    (Array.isArray(checkpointContent) ? checkpointContent : null);

  if (baseContent === null) {
    return null;
  }

  const nextContent = [...baseContent];
  const part = nextContent[partIndex];
  if (!isToolResultPart(part)) {
    return null;
  }

  const originalTokens = estimateUnknownContentTokens(part.content);
  nextContent[partIndex] = {
    ...part,
    content: replacementText,
  };

  return {
    nextContent,
    tokensSaved:
      originalTokens > replacementTokens
        ? originalTokens - replacementTokens
        : 0,
  };
}

function mergeModifiedMessageIndexes(
  target: Set<number>,
  source: Set<number>
): void {
  for (const index of source) {
    target.add(index);
  }
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
    return {
      messages: [],
      tokensSaved: 0,
      messagesModified: 0,
      toolResultsCleared: 0,
    };
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

  const assistantCompaction = applyAssistantTextCompaction(
    messages,
    protectedFromIndex,
    maxResponseTokens,
    replacementTemplate,
    minSavingsTokens
  );

  let resultMessages = assistantCompaction.messages;
  let tokensSaved = assistantCompaction.tokensSaved;
  let toolResultsCleared = 0;
  const modifiedMessageIndexes = new Set<number>(
    assistantCompaction.modifiedMessageIndexes
  );

  const clearOlderThanMs = options.clearOlderThanMs;
  const hasClearOlderThanMs =
    typeof clearOlderThanMs === "number" && Number.isFinite(clearOlderThanMs);
  const shouldClearToolResults =
    options.clearToolResults === true || hasClearOlderThanMs;

  if (shouldClearToolResults) {
    const clearableToolNames = Array.isArray(options.clearableToolNames)
      ? new Set(options.clearableToolNames)
      : null;
    const clearOlderThanTimestamp = hasClearOlderThanMs
      ? Date.now() - Math.max(0, clearOlderThanMs)
      : null;

    const toolResultClearResult = applyToolResultClearing(resultMessages, {
      clearOlderThanTimestamp,
      clearableToolNames,
      keepRecentToolResults: Math.max(
        0,
        options.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS
      ),
      replacementText:
        options.toolResultReplacementText ??
        DEFAULT_TOOL_RESULT_REPLACEMENT_TEXT,
    });

    resultMessages = toolResultClearResult.messages;
    tokensSaved += toolResultClearResult.tokensSaved;
    toolResultsCleared = toolResultClearResult.toolResultsCleared;
    mergeModifiedMessageIndexes(
      modifiedMessageIndexes,
      toolResultClearResult.modifiedMessageIndexes
    );
  }

  return {
    messages: resultMessages,
    tokensSaved,
    messagesModified: modifiedMessageIndexes.size,
    toolResultsCleared,
  };
}
