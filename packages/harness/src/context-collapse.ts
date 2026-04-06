import type { ModelMessage } from "ai";
import type { CheckpointMessage } from "./compaction-types";
import { estimateTokens } from "./token-utils";

const DEFAULT_READ_TOOL_NAMES = ["read_file", "Read"];
const DEFAULT_SEARCH_TOOL_NAMES = ["grep", "glob", "Grep", "Glob"];
const DEFAULT_SHELL_TOOL_NAMES = ["bash", "Bash", "shell_execute", "Shell"];
const DEFAULT_MIN_GROUP_SIZE = 2;
const DEFAULT_PROTECT_RECENT_MESSAGES = 5;
const MAX_HINTS_IN_LABEL = 5;
const MAX_HINT_LENGTH = 80;

type CollapsibleType = Exclude<CollapsedGroup["type"], "mixed">;

interface NormalizedToolCall {
  input: unknown;
  partIndex: number;
  toolCallId: string;
  toolName: string;
}

interface NormalizedToolResult {
  partIndex: number;
  payload: unknown;
  payloadField: "content" | "output";
  toolCallId: string;
  toolName: string;
}

interface CollapsibleOperation {
  callMessageIndex: number;
  hint?: string;
  payloadField: "content" | "output";
  resultMessageIndex: number;
  resultPartIndex: number;
  resultPayload: unknown;
  toolName: string;
  type: CollapsibleType;
}

export interface CollapsedGroup {
  collapsedTokens: number;
  count: number;
  label: string;
  originalTokens: number;
  type: "read" | "search" | "shell" | "mixed";
}

export interface CollapseResult {
  groups: CollapsedGroup[];
  messages: CheckpointMessage[];
  tokensSaved: number;
}

export interface CollapseOptions {
  minGroupSize?: number;
  protectRecentMessages?: number;
  readToolNames?: string[];
  searchToolNames?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toLowerNameSet(names: string[]): Set<string> {
  const set = new Set<string>();

  for (const name of names) {
    const normalized = name.trim().toLowerCase();
    if (normalized.length === 0) {
      continue;
    }
    set.add(normalized);
  }

  return set;
}

function clampNonNegativeInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}

function resolveMinGroupSize(minGroupSize: number | undefined): number {
  if (minGroupSize == null) {
    return DEFAULT_MIN_GROUP_SIZE;
  }

  return Math.max(
    1,
    clampNonNegativeInteger(minGroupSize, DEFAULT_MIN_GROUP_SIZE)
  );
}

function resolveProtectRecentMessages(
  protectRecentMessages: number | undefined
): number {
  if (protectRecentMessages == null) {
    return DEFAULT_PROTECT_RECENT_MESSAGES;
  }

  return clampNonNegativeInteger(
    protectRecentMessages,
    DEFAULT_PROTECT_RECENT_MESSAGES
  );
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    return String(value);
  }

  return String(value);
}

function estimateToolResultTokens(toolName: string, payload: unknown): number {
  const normalizedToolName = toolName.trim();
  const prefix = normalizedToolName.length > 0 ? `${normalizedToolName} ` : "";
  return estimateTokens(`${prefix}${stringifyUnknown(payload)}`);
}

function normalizeHint(value: string): string {
  const compact = value.trim().replace(/\s+/g, " ");
  if (compact.length <= MAX_HINT_LENGTH) {
    return compact;
  }

  return `${compact.slice(0, MAX_HINT_LENGTH - 1)}…`;
}

function getInputString(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = input[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeHint(value);
  return normalized.length > 0 ? normalized : undefined;
}

function parseToolCallPart(
  part: unknown
): Omit<NormalizedToolCall, "partIndex"> | null {
  if (!isRecord(part) || typeof part.type !== "string") {
    return null;
  }

  if (part.type === "tool-call") {
    if (
      typeof part.toolCallId !== "string" ||
      typeof part.toolName !== "string"
    ) {
      return null;
    }

    return {
      input: part.input,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
    };
  }

  if (part.type === "tool_use") {
    if (typeof part.id !== "string" || typeof part.name !== "string") {
      return null;
    }

    return {
      input: part.input,
      toolCallId: part.id,
      toolName: part.name,
    };
  }

  return null;
}

function getSingleToolCall(message: ModelMessage): NormalizedToolCall | null {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return null;
  }

  let foundCall: NormalizedToolCall | null = null;

  for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
    const parsed = parseToolCallPart(message.content[partIndex]);
    if (!parsed) {
      continue;
    }

    if (foundCall !== null) {
      return null;
    }

    foundCall = {
      ...parsed,
      partIndex,
    };
  }

  return foundCall;
}

function parseToolResultPart(
  part: unknown
): Omit<NormalizedToolResult, "partIndex"> | null {
  if (!isRecord(part) || typeof part.type !== "string") {
    return null;
  }

  if (part.type !== "tool-result" && part.type !== "tool_result") {
    return null;
  }

  let toolCallId: string | null = null;
  if (typeof part.toolCallId === "string") {
    toolCallId = part.toolCallId;
  } else if (typeof part.tool_use_id === "string") {
    toolCallId = part.tool_use_id;
  }

  if (toolCallId === null) {
    return null;
  }

  let toolName = "";
  if (typeof part.toolName === "string") {
    toolName = part.toolName;
  } else if (typeof part.tool_name === "string") {
    toolName = part.tool_name;
  } else if (typeof part.name === "string") {
    toolName = part.name;
  }

  if ("output" in part) {
    return {
      payload: part.output,
      payloadField: "output",
      toolCallId,
      toolName,
    };
  }

  return {
    payload: part.content,
    payloadField: "content",
    toolCallId,
    toolName,
  };
}

function getMatchingToolResult(
  message: ModelMessage,
  toolCallId: string
): NormalizedToolResult | null {
  if (
    (message.role !== "tool" && message.role !== "user") ||
    !Array.isArray(message.content)
  ) {
    return null;
  }

  for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
    const parsed = parseToolResultPart(message.content[partIndex]);
    if (!parsed || parsed.toolCallId !== toolCallId) {
      continue;
    }

    return {
      ...parsed,
      partIndex,
    };
  }

  return null;
}

function resolveOperationType(
  toolName: string,
  readToolNames: Set<string>,
  searchToolNames: Set<string>,
  shellToolNames: Set<string>
): CollapsibleType | null {
  const normalized = toolName.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  if (readToolNames.has(normalized)) {
    return "read";
  }

  if (searchToolNames.has(normalized)) {
    return "search";
  }

  if (shellToolNames.has(normalized)) {
    return "shell";
  }

  return null;
}

function extractOperationHint(
  type: CollapsibleType,
  input: unknown
): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  if (type === "read") {
    return (
      getInputString(input, "file_path") ??
      getInputString(input, "path") ??
      getInputString(input, "filePath")
    );
  }

  if (type === "search") {
    const path = getInputString(input, "path");
    const pattern =
      getInputString(input, "pattern") ??
      getInputString(input, "glob") ??
      getInputString(input, "query");

    if (path && pattern) {
      return `${path}:${pattern}`;
    }

    return path ?? pattern;
  }

  return getInputString(input, "command");
}

function collectOperations(
  messages: CheckpointMessage[],
  collapseLimit: number,
  readToolNames: Set<string>,
  searchToolNames: Set<string>,
  shellToolNames: Set<string>
): CollapsibleOperation[] {
  const operations: CollapsibleOperation[] = [];

  let messageIndex = 0;
  while (messageIndex + 1 < collapseLimit) {
    const callMessage = messages[messageIndex];
    if (!callMessage) {
      messageIndex += 1;
      continue;
    }

    const call = getSingleToolCall(callMessage.message);
    if (!call) {
      messageIndex += 1;
      continue;
    }

    const type = resolveOperationType(
      call.toolName,
      readToolNames,
      searchToolNames,
      shellToolNames
    );
    if (!type) {
      messageIndex += 1;
      continue;
    }

    const resultMessage = messages[messageIndex + 1];
    if (!resultMessage) {
      messageIndex += 1;
      continue;
    }

    const result = getMatchingToolResult(
      resultMessage.message,
      call.toolCallId
    );
    if (!result) {
      messageIndex += 1;
      continue;
    }

    const resolvedToolName =
      result.toolName.trim().length > 0 ? result.toolName : call.toolName;

    operations.push({
      callMessageIndex: messageIndex,
      hint: extractOperationHint(type, call.input),
      payloadField: result.payloadField,
      resultMessageIndex: messageIndex + 1,
      resultPartIndex: result.partIndex,
      resultPayload: result.payload,
      toolName: resolvedToolName,
      type,
    });

    messageIndex += 2;
  }

  return operations;
}

function groupConsecutiveOperations(
  operations: CollapsibleOperation[]
): CollapsibleOperation[][] {
  if (operations.length === 0) {
    return [];
  }

  const groups: CollapsibleOperation[][] = [];
  let currentGroup: CollapsibleOperation[] = [operations[0]];

  for (let index = 1; index < operations.length; index++) {
    const operation = operations[index];
    const previous = operations[index - 1];

    const isConsecutive =
      operation.callMessageIndex === previous.resultMessageIndex + 1;
    if (isConsecutive) {
      currentGroup.push(operation);
      continue;
    }

    groups.push(currentGroup);
    currentGroup = [operation];
  }

  groups.push(currentGroup);
  return groups;
}

function uniqueHints(operations: CollapsibleOperation[]): string[] {
  const seen = new Set<string>();
  const hints: string[] = [];

  for (const operation of operations) {
    if (!operation.hint) {
      continue;
    }

    if (seen.has(operation.hint)) {
      continue;
    }

    seen.add(operation.hint);
    hints.push(operation.hint);
  }

  return hints;
}

function resolveGroupType(
  operations: CollapsibleOperation[]
): CollapsedGroup["type"] {
  const typeSet = new Set<CollapsibleType>();

  for (const operation of operations) {
    typeSet.add(operation.type);
  }

  if (typeSet.size !== 1) {
    return "mixed";
  }

  return operations[0]?.type ?? "mixed";
}

function formatGroupLead(type: CollapsedGroup["type"], count: number): string {
  if (type === "read") {
    return `${count} file read${count === 1 ? "" : "s"}`;
  }

  if (type === "search") {
    return `${count} search${count === 1 ? "" : "es"}`;
  }

  if (type === "shell") {
    return `${count} shell command${count === 1 ? "" : "s"}`;
  }

  return `${count} mixed operation${count === 1 ? "" : "s"}`;
}

function buildGroupLabel(
  operations: CollapsibleOperation[],
  groupType: CollapsedGroup["type"]
): string {
  const hints = uniqueHints(operations);
  const visibleHints = hints.slice(0, MAX_HINTS_IN_LABEL);

  if (hints.length > MAX_HINTS_IN_LABEL) {
    visibleHints.push(`+${hints.length - MAX_HINTS_IN_LABEL} more`);
  }

  const suffix = visibleHints.length > 0 ? ` — ${visibleHints.join(", ")}` : "";
  return `[Collapsed: ${formatGroupLead(groupType, operations.length)}${suffix}]`;
}

function rewriteToolResultPart(part: unknown, summary: string): unknown | null {
  if (!isRecord(part) || typeof part.type !== "string") {
    return null;
  }

  if (part.type !== "tool-result" && part.type !== "tool_result") {
    return null;
  }

  if ("output" in part) {
    return {
      ...part,
      output: { type: "text" as const, value: summary },
    };
  }

  if ("content" in part) {
    return {
      ...part,
      content: summary,
    };
  }

  return {
    ...part,
    output: { type: "text" as const, value: summary },
  };
}

function collapseOperationGroup(
  messages: CheckpointMessage[],
  operations: CollapsibleOperation[]
): {
  group: CollapsedGroup;
  messages: CheckpointMessage[];
  tokensSaved: number;
} {
  const groupType = resolveGroupType(operations);
  const label = buildGroupLabel(operations, groupType);
  const replacementOutput = { type: "text" as const, value: label };

  let originalTokens = 0;
  let collapsedTokens = 0;
  const nextMessages = [...messages];

  for (const operation of operations) {
    const checkpointMessage = nextMessages[operation.resultMessageIndex];
    if (
      !(checkpointMessage && Array.isArray(checkpointMessage.message.content))
    ) {
      continue;
    }

    const content = [...checkpointMessage.message.content];
    const currentPart = content[operation.resultPartIndex];
    const rewrittenPart = rewriteToolResultPart(currentPart, label);
    if (!rewrittenPart) {
      continue;
    }

    content[operation.resultPartIndex] = rewrittenPart as never;
    nextMessages[operation.resultMessageIndex] = {
      ...checkpointMessage,
      message: {
        ...checkpointMessage.message,
        content: content as ModelMessage["content"],
      } as ModelMessage,
    };

    originalTokens += estimateToolResultTokens(
      operation.toolName,
      operation.resultPayload
    );
    collapsedTokens += estimateToolResultTokens(
      operation.toolName,
      operation.payloadField === "output" ? replacementOutput : label
    );
  }

  return {
    group: {
      collapsedTokens,
      count: operations.length,
      label,
      originalTokens,
      type: groupType,
    },
    messages: nextMessages,
    tokensSaved: Math.max(0, originalTokens - collapsedTokens),
  };
}

export function collapseConsecutiveOps(
  messages: CheckpointMessage[],
  options: CollapseOptions = {}
): CollapseResult {
  const readToolNames = toLowerNameSet(
    options.readToolNames ?? DEFAULT_READ_TOOL_NAMES
  );
  const searchToolNames = toLowerNameSet(
    options.searchToolNames ?? DEFAULT_SEARCH_TOOL_NAMES
  );
  const shellToolNames = toLowerNameSet(DEFAULT_SHELL_TOOL_NAMES);

  const minGroupSize = resolveMinGroupSize(options.minGroupSize);
  const protectRecentMessages = resolveProtectRecentMessages(
    options.protectRecentMessages
  );

  const collapseLimit = Math.max(0, messages.length - protectRecentMessages);
  const operations = collectOperations(
    messages,
    collapseLimit,
    readToolNames,
    searchToolNames,
    shellToolNames
  );
  const operationGroups = groupConsecutiveOperations(operations);

  let collapsedMessages = [...messages];
  const groups: CollapsedGroup[] = [];
  let tokensSaved = 0;

  for (const operationGroup of operationGroups) {
    if (operationGroup.length < minGroupSize) {
      continue;
    }

    const collapsed = collapseOperationGroup(collapsedMessages, operationGroup);
    collapsedMessages = collapsed.messages;
    groups.push(collapsed.group);
    tokensSaved += collapsed.tokensSaved;
  }

  return {
    groups,
    messages: collapsedMessages,
    tokensSaved,
  };
}
