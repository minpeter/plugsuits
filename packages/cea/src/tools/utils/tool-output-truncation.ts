import {
  type TruncationResult,
  truncateOutput,
} from "./execute/output-handler";

const DEFAULT_TOOL_LIMITS: Record<
  string,
  { maxBytes: number; maxLines: number }
> = {
  grep_files: { maxBytes: 32 * 1024, maxLines: 500 },
  read_file: { maxBytes: 32 * 1024, maxLines: 800 },
};

let contextBudgetBytes: number | null = null;

export function setContextBudgetForTools(remainingTokens: number): void {
  contextBudgetBytes = Math.max(1024, Math.floor((remainingTokens * 4) / 2));
}

export function clearContextBudgetForTools(): void {
  contextBudgetBytes = null;
}

function getEffectiveLimits(
  toolName: string
): { maxBytes: number; maxLines: number } | undefined {
  const base = DEFAULT_TOOL_LIMITS[toolName];
  if (!base) {
    return undefined;
  }
  if (contextBudgetBytes === null) {
    return base;
  }
  return {
    maxBytes: Math.min(base.maxBytes, contextBudgetBytes),
    maxLines: base.maxLines,
  };
}
const READ_FILE_PATH_PATTERN = /^path: (.+)$/m;
const READ_FILE_RANGE_PATTERN = /^range: (.+)$/m;
const READ_FILE_LINES_PATTERN = /^lines: (.+)$/m;
const GREP_PATTERN_PATTERN = /^pattern: (.+)$/m;
const GREP_PATH_PATTERN = /^path: (.+)$/m;
const GREP_MATCH_COUNT_PATTERN = /^match_count: (.+)$/m;

export async function truncateToolOutput(
  toolName: string,
  text: string
): Promise<TruncationResult> {
  const limits = getEffectiveLimits(toolName);
  if (!limits) {
    return {
      text,
      truncated: false,
      originalLines: text.split("\n").length,
      originalBytes: Buffer.byteLength(text),
    };
  }

  const truncated = await truncateOutput(text, limits);
  if (!truncated.truncated) {
    return truncated;
  }

  if (toolName === "read_file") {
    const path = text.match(READ_FILE_PATH_PATTERN)?.[1] ?? "unknown";
    const range = text.match(READ_FILE_RANGE_PATTERN)?.[1] ?? "unknown";
    const lines = text.match(READ_FILE_LINES_PATTERN)?.[1] ?? "unknown";
    return {
      ...truncated,
      text: [
        "OK - read file (truncated for context safety)",
        `path: ${path}`,
        `range: ${range}`,
        `lines: ${lines}`,
        `full_output_path: ${truncated.fullOutputPath}`,
        "Use read_file again on the original path with offset, limit, or around_line for the exact section you need.",
      ].join("\n"),
    };
  }

  if (toolName === "grep_files") {
    const pattern = text.match(GREP_PATTERN_PATTERN)?.[1] ?? "unknown";
    const path = text.match(GREP_PATH_PATTERN)?.[1] ?? ".";
    const matchCount = text.match(GREP_MATCH_COUNT_PATTERN)?.[1] ?? "unknown";
    return {
      ...truncated,
      text: [
        "OK - grep (truncated for context safety)",
        `pattern: ${pattern}`,
        `path: ${path}`,
        `match_count: ${matchCount}`,
        `full_output_path: ${truncated.fullOutputPath}`,
        "Use grep_files again with a narrower path, include glob, or fixed_strings=true if you need exact matches.",
      ].join("\n"),
    };
  }

  return truncated;
}
