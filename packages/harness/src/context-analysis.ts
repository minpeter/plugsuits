import type { CheckpointMessage } from "./compaction-types";
import { estimateTokens, extractMessageText } from "./token-utils";

const DEFAULT_TOP_N = 5;
const MAX_PATH_SCAN_DEPTH = 4;
const MAX_TEXT_SCAN_LENGTH = 1500;
const LEADING_PATH_NOISE_REGEX = /^["'`(]+/;
const TRAILING_PATH_NOISE_REGEX = /["'`),.;:]+$/;
const WHITESPACE_REGEX = /\s/;
const WINDOWS_PATH_PREFIX_REGEX = /^[A-Za-z]:\\/;
const FILE_EXTENSION_REGEX = /\.[A-Za-z0-9]{1,12}$/;

const TEXT_PATH_PATTERNS: RegExp[] = [
  /\b(?:file|filepath|file_path|path)\s*[:=]\s*([^\s"'`<>]+(?:\/[^\s"'`<>]+|\\[^\s"'`<>]+)*)/gi,
  /((?:\/|\.{1,2}\/)[^\s"'`<>{}\]]+\.[A-Za-z0-9]{1,12})/g,
  /((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})/g,
  /([A-Za-z]:\\(?:[^\\\s"'`<>|]+\\)*[^\\\s"'`<>|]+\.[A-Za-z0-9]{1,12})/g,
];

export interface ContextTokenStats {
  byRole: {
    system: number;
    user: number;
    assistant: number;
    tool: number;
  };
  duplicateReads: Map<string, { count: number; wastedTokens: number }>;
  largestMessages: Array<{ index: number; role: string; tokens: number }>;
  toolResults: Map<string, { count: number; tokens: number }>;
  total: number;
}

type TrackedRole = keyof ContextTokenStats["byRole"];

interface ToolResultPart {
  output: unknown;
  toolName?: unknown;
  type: "tool-result";
}

interface DuplicateReadAccumulator {
  count: number;
  totalTokens: number;
}

function isToolResultPart(part: unknown): part is ToolResultPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "tool-result" &&
    "output" in part
  );
}

function isTrackedRole(role: string): role is TrackedRole {
  return (
    role === "system" ||
    role === "user" ||
    role === "assistant" ||
    role === "tool"
  );
}

function resolveToolName(toolName: unknown): string {
  if (typeof toolName !== "string") {
    return "unknown";
  }

  const normalized = toolName.trim();
  return normalized.length > 0 ? normalized : "unknown";
}

function normalizePathCandidate(path: string): string {
  return path
    .trim()
    .replace(LEADING_PATH_NOISE_REGEX, "")
    .replace(TRAILING_PATH_NOISE_REGEX, "");
}

function isLikelyFilePath(path: string): boolean {
  if (path.length < 3 || path.length > 260) {
    return false;
  }

  if (path.includes("://") || WHITESPACE_REGEX.test(path)) {
    return false;
  }

  if (WINDOWS_PATH_PREFIX_REGEX.test(path)) {
    return true;
  }

  if (path.startsWith("/") || path.startsWith("./") || path.startsWith("../")) {
    return FILE_EXTENSION_REGEX.test(path);
  }

  if (path.includes("/")) {
    return FILE_EXTENSION_REGEX.test(path);
  }

  return false;
}

function isPathKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "path" ||
    normalized === "filepath" ||
    normalized === "file_path" ||
    normalized.endsWith("path")
  );
}

function findPathInText(text: string): string | undefined {
  for (const pattern of TEXT_PATH_PATTERNS) {
    pattern.lastIndex = 0;

    let match = pattern.exec(text);
    while (match !== null) {
      const rawPath = match[1] ?? match[0];
      const normalized = normalizePathCandidate(rawPath);
      if (isLikelyFilePath(normalized)) {
        return normalized;
      }
      match = pattern.exec(text);
    }
  }

  return undefined;
}

function findPathFromPathKeys(
  record: Record<string, unknown>
): string | undefined {
  for (const [key, nestedValue] of Object.entries(record)) {
    if (!isPathKey(key) || typeof nestedValue !== "string") {
      continue;
    }

    const normalized = normalizePathCandidate(nestedValue);
    if (isLikelyFilePath(normalized)) {
      return normalized;
    }
  }

  return undefined;
}

function findPathFromNestedValues(
  values: unknown[],
  depth: number
): string | undefined {
  for (const nestedValue of values) {
    if (typeof nestedValue === "string") {
      const fromText = findPathInText(
        nestedValue.slice(0, MAX_TEXT_SCAN_LENGTH)
      );
      if (fromText) {
        return fromText;
      }
      continue;
    }

    const path = findPathByKey(nestedValue, depth);
    if (path) {
      return path;
    }
  }

  return undefined;
}

function findPathByKey(value: unknown, depth = 0): string | undefined {
  if (
    depth > MAX_PATH_SCAN_DEPTH ||
    value == null ||
    typeof value !== "object"
  ) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return findPathFromNestedValues(value, depth + 1);
  }

  const record = value as Record<string, unknown>;
  return (
    findPathFromPathKeys(record) ??
    findPathFromNestedValues(Object.values(record), depth + 1)
  );
}

function extractOutputText(output: unknown, depth = 0): string {
  if (output == null) {
    return "";
  }

  if (typeof output === "string") {
    return output;
  }

  if (
    typeof output === "number" ||
    typeof output === "boolean" ||
    typeof output === "bigint"
  ) {
    return String(output);
  }

  if (typeof output !== "object" || depth > MAX_PATH_SCAN_DEPTH) {
    return "";
  }

  if (Array.isArray(output)) {
    return output
      .map((item) => extractOutputText(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }

  const record = output as Record<string, unknown>;

  if (typeof record.value === "string") {
    return record.value;
  }

  if (typeof record.text === "string") {
    return record.text;
  }

  return Object.values(record)
    .map((value) => extractOutputText(value, depth + 1))
    .filter(Boolean)
    .join("\n");
}

function estimateOutputTokens(output: unknown): number {
  const text = extractOutputText(output);
  if (text.length > 0) {
    return estimateTokens(text);
  }

  if (output == null) {
    return 0;
  }

  try {
    const serialized = JSON.stringify(output);
    return typeof serialized === "string" ? estimateTokens(serialized) : 0;
  } catch {
    return estimateTokens(String(output));
  }
}

function getPrimaryReadPath(output: unknown): string | undefined {
  const byKey = findPathByKey(output);
  if (byKey) {
    return byKey;
  }

  const text = extractOutputText(output);
  if (text.length === 0) {
    return undefined;
  }

  return findPathInText(text.slice(0, MAX_TEXT_SCAN_LENGTH));
}

function getTopN(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TOP_N;
  }
  return Math.max(0, Math.floor(value));
}

export function analyzeContextTokens(
  messages: CheckpointMessage[],
  options?: { topN?: number }
): ContextTokenStats {
  const topN = getTopN(options?.topN);

  const byRole: ContextTokenStats["byRole"] = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
  };
  const toolResults = new Map<string, { count: number; tokens: number }>();
  const duplicateReadAccumulator = new Map<string, DuplicateReadAccumulator>();
  const largestMessages: Array<{
    index: number;
    role: string;
    tokens: number;
  }> = [];

  let total = 0;

  for (let index = 0; index < messages.length; index++) {
    const checkpointMessage = messages[index];
    const role = String(checkpointMessage.message.role);
    const messageTokens = estimateTokens(
      extractMessageText(checkpointMessage.message)
    );

    total += messageTokens;

    if (isTrackedRole(role)) {
      byRole[role] += messageTokens;
    }

    largestMessages.push({ index, role, tokens: messageTokens });

    const content = checkpointMessage.message.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!isToolResultPart(part)) {
        continue;
      }

      const toolName = resolveToolName(part.toolName);
      const partTokens = estimateOutputTokens(part.output);
      const existingToolStats = toolResults.get(toolName) ?? {
        count: 0,
        tokens: 0,
      };

      toolResults.set(toolName, {
        count: existingToolStats.count + 1,
        tokens: existingToolStats.tokens + partTokens,
      });

      const path = getPrimaryReadPath(part.output);
      if (!path) {
        continue;
      }

      const duplicateStats = duplicateReadAccumulator.get(path) ?? {
        count: 0,
        totalTokens: 0,
      };

      duplicateReadAccumulator.set(path, {
        count: duplicateStats.count + 1,
        totalTokens: duplicateStats.totalTokens + partTokens,
      });
    }
  }

  const duplicateReads = new Map<
    string,
    { count: number; wastedTokens: number }
  >();
  for (const [path, data] of duplicateReadAccumulator.entries()) {
    if (data.count <= 1) {
      continue;
    }

    const averageTokens = Math.floor(data.totalTokens / data.count);
    const wastedTokens = averageTokens * (data.count - 1);
    duplicateReads.set(path, { count: data.count, wastedTokens });
  }

  const topLargestMessages =
    topN <= 0
      ? []
      : largestMessages.sort((a, b) => b.tokens - a.tokens).slice(0, topN);

  return {
    total,
    byRole,
    toolResults,
    duplicateReads,
    largestMessages: topLargestMessages,
  };
}
