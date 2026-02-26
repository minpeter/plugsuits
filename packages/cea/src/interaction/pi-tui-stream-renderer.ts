import {
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { parsePartialJson, type TextStreamPart, type ToolSet } from "ai";

type StreamPart = TextStreamPart<ToolSet>;

interface ToolInputRenderState {
  hasContent: boolean;
  inputBuffer: string;
  renderedInputLength: number;
  toolName: string;
}

export interface PiTuiStreamRenderOptions {
  chatContainer: Container;
  markdownTheme: MarkdownTheme;
  onFirstVisiblePart?: () => void;
  showFiles?: boolean;
  showFinishReason?: boolean;
  showRawToolIo?: boolean;
  showReasoning?: boolean;
  showSources?: boolean;
  showSteps?: boolean;
  showToolResults?: boolean;
  ui: {
    requestRender: () => void;
  };
}

interface ToolInputPart {
  id?: string;
  toolCallId?: string;
}

interface ToolInputDeltaPart extends ToolInputPart {
  delta?: unknown;
  inputTextDelta?: unknown;
}

const addChatComponent = (
  chatContainer: Container,
  component: Container | Text | Markdown,
  options: { addLeadingSpacer?: boolean } = {}
): void => {
  if (options.addLeadingSpacer ?? true) {
    chatContainer.addChild(new Spacer(1));
  }
  chatContainer.addChild(component);
};

const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const isPlainEmptyObject = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (Array.isArray(value)) {
    return false;
  }

  return Object.keys(value).length === 0;
};

const renderCodeBlock = (language: string, value: unknown): string => {
  const text = safeStringify(value).replace(TRAILING_NEWLINES, "");
  const longestFenceRun = Array.from(
    text.matchAll(BACKTICK_FENCE_PATTERN)
  ).reduce((max, match) => Math.max(max, match[0].length), 2);
  const fence = "`".repeat(longestFenceRun + 1);
  return `${fence}${language}\n${text}\n${fence}`;
};

const READ_FILE_SUCCESS_PREFIX = "OK - read file";
const GLOB_SUCCESS_PREFIX = "OK - glob";
const GREP_SUCCESS_PREFIX = "OK - grep";
const SHELL_EXECUTE_TOOL_NAMES = new Set(["shell_execute", "bash"]);
const SHELL_TOOL_NAMES = new Set(["shell_execute", "bash", "shell_interact"]);
const UNKNOWN_TOOL_NAME = "tool";
const READ_FILE_BLOCK_PREFIX = "======== ";
const READ_FILE_BLOCK_SUFFIX = " ========";
const READ_FILE_BLOCK_END = "======== end ========";
const BACKTICK_FENCE_PATTERN = /`{3,}/g;
const READ_FILE_LINE_SPLIT_PATTERN = /^(\s*\d+(?:#[^\s|]+)?\s*\|\s*)(.*)$/;
const READ_FILE_LINES_WITH_RETURNED_PATTERN = /^(\d+)\s+\(returned:\s*(\d+)\)$/;
const READ_FILE_MARKDOWN_FENCE_PATTERN = /^(?:`{3,}|~{3,}).*$/;
const SURROUNDED_BY_DOUBLE_QUOTES_PATTERN = /^"(.*)"$/;
const TAB_PATTERN = /\t/g;
const MAX_READ_PREVIEW_LINES = 10;
const TOOL_PENDING_MESSAGE = "Executing..";
const TOOL_PENDING_MARKER = "__tool_pending_status__";
const TOOL_PENDING_SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;
const HASHLINE_TAG_ONLY_PATTERN = /^(.*\d+#[ZPMQVRWSNKTXJBYH]{2})\s*$/;
const HASHLINE_PIPE_ONLY_PATTERN = /^\|\s*(.*)$/;
const HASHLINE_TAG_PIPE_ONLY_PATTERN =
  /^(.*\d+#[ZPMQVRWSNKTXJBYH]{2})\s*\|\s*$/;
const HASHLINE_COMPACT_LINE_PATTERN = /^\s*\d+#[ZPMQVRWSNKTXJBYH]{2}\|.*$/;

const isTruthyEnvFlag = (value: string | undefined): boolean => {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};

const isRawToolIoEnabledByEnv = (): boolean => {
  return isTruthyEnvFlag(process.env.DEBUG_SHOW_RAW_TOOL_IO);
};

interface ReadFileParsedOutput {
  blockBody: string;
  blockTitle: string;
  metadata: Map<string, string>;
}

const extractStringField = (input: unknown, field: string): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const record = input as Record<string, unknown>;
  return typeof record[field] === "string" ? (record[field] as string) : null;
};

const extractNumberField = (input: unknown, field: string): number | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const extractBooleanField = (input: unknown, field: string): boolean | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const record = input as Record<string, unknown>;
  return typeof record[field] === "boolean" ? (record[field] as boolean) : null;
};

const buildTextPreviewLines = (
  text: string,
  emptyText = "(empty)"
): string[] => {
  const normalized = text.replaceAll("\r\n", "\n").trimEnd();
  if (normalized.length === 0) {
    return [emptyText];
  }

  const allLines = normalized.split("\n");
  const omittedLines = Math.max(0, allLines.length - MAX_READ_PREVIEW_LINES);
  const visibleLines =
    omittedLines > 0 ? allLines.slice(0, MAX_READ_PREVIEW_LINES) : allLines;

  const preview = [...visibleLines];
  if (omittedLines > 0) {
    const lineLabel = `line${omittedLines === 1 ? "" : "s"}`;
    preview.push("");
    preview.push(`... (${omittedLines} more ${lineLabel})`);
  }

  return preview;
};

const buildPrettyHeader = (title: string, target: string): string => {
  return `**${title}** \`${target}\``;
};

const normalizeHashlineBreakArtifacts = (lines: string[]): string[] => {
  const normalized: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index].replaceAll("\r", "");
    const next = lines[index + 1]?.replaceAll("\r", "");
    const nextNext = lines[index + 2]?.replaceAll("\r", "");

    const currentTagOnly = current.match(HASHLINE_TAG_ONLY_PATTERN);
    const nextPipeOnly = next?.match(HASHLINE_PIPE_ONLY_PATTERN);
    const nextLooksLikeHashline =
      next !== undefined && HASHLINE_COMPACT_LINE_PATTERN.test(next);
    const nextNextLooksLikeHashline =
      nextNext !== undefined && HASHLINE_COMPACT_LINE_PATTERN.test(nextNext);

    if (currentTagOnly && nextPipeOnly) {
      const pipedContent = nextPipeOnly[1].trim();
      if (pipedContent.length > 0) {
        normalized.push(`${currentTagOnly[1]}|${pipedContent}`);
        index += 1;
        continue;
      }

      if (nextNext !== undefined && !nextNextLooksLikeHashline) {
        normalized.push(`${currentTagOnly[1]}|${nextNext.trimStart()}`);
        index += 2;
        continue;
      }
    }

    const currentTagPipeOnly = current.match(HASHLINE_TAG_PIPE_ONLY_PATTERN);
    if (currentTagPipeOnly && next !== undefined && !nextLooksLikeHashline) {
      normalized.push(`${currentTagPipeOnly[1]}|${next.trimStart()}`);
      index += 1;
      continue;
    }

    normalized.push(current);
  }

  return normalized;
};

const shouldIncludeReadFilePreviewLine = (line: string): boolean => {
  const match = line.match(READ_FILE_LINE_SPLIT_PATTERN);
  const content = (match?.[2] ?? line).trim();
  return !READ_FILE_MARKDOWN_FENCE_PATTERN.test(content);
};

interface ReadFileRenderPayload {
  body: string;
  path: string;
  range: string | null;
}

interface GlobRenderPayload {
  body: string;
  pattern: string;
}

interface GrepRenderPayload {
  body: string;
  pattern: string;
}

interface GlobPreviewMetadata {
  truncated: boolean;
}

interface GrepPreviewMetadata {
  matchCount: string | null;
  path: string | null;
  truncated: boolean;
}

const stripSurroundedDoubleQuotes = (value: string): string => {
  const trimmed = value.trim();
  const matched = trimmed.match(SURROUNDED_BY_DOUBLE_QUOTES_PATTERN);
  return matched?.[1] ?? trimmed;
};

const parseReadFileMetadataLine = (
  line: string
): { key: string; value: string } | null => {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = line.slice(0, separatorIndex).trim();
  if (key.length === 0) {
    return null;
  }

  return {
    key,
    value: line.slice(separatorIndex + 1).trim(),
  };
};

const parseNumberedBlockToolOutput = (
  output: string,
  successPrefix: string
): ReadFileParsedOutput | null => {
  const normalized = output.replaceAll("\r\n", "\n");
  if (!normalized.startsWith(successPrefix)) {
    return null;
  }

  const lines = normalized.split("\n");
  const metadata = new Map<string, string>();
  let blockStartIndex = -1;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (
      line.startsWith(READ_FILE_BLOCK_PREFIX) &&
      line.endsWith(READ_FILE_BLOCK_SUFFIX) &&
      line !== READ_FILE_BLOCK_END
    ) {
      blockStartIndex = index;
      break;
    }

    if (line.trim().length === 0) {
      continue;
    }

    const parsed = parseReadFileMetadataLine(line);
    if (!parsed) {
      return null;
    }
    metadata.set(parsed.key, parsed.value);
  }

  if (blockStartIndex < 0) {
    return null;
  }

  const blockEndIndex = lines.findIndex(
    (line, index) => index > blockStartIndex && line === READ_FILE_BLOCK_END
  );
  if (blockEndIndex < 0) {
    return null;
  }

  const blockTitle = lines[blockStartIndex]
    .slice(READ_FILE_BLOCK_PREFIX.length, -READ_FILE_BLOCK_SUFFIX.length)
    .trim();
  const blockBody = lines.slice(blockStartIndex + 1, blockEndIndex).join("\n");

  return {
    metadata,
    blockTitle,
    blockBody,
  };
};

const parseReadFileOutput = (output: string): ReadFileParsedOutput | null => {
  return parseNumberedBlockToolOutput(output, READ_FILE_SUCCESS_PREFIX);
};

const parseGlobOutput = (output: string): ReadFileParsedOutput | null => {
  return parseNumberedBlockToolOutput(output, GLOB_SUCCESS_PREFIX);
};

const parseGrepOutput = (output: string): ReadFileParsedOutput | null => {
  return parseNumberedBlockToolOutput(output, GREP_SUCCESS_PREFIX);
};

const resolveReadPath = (parsed: ReadFileParsedOutput): string => {
  const pathValue = parsed.metadata.get("path") ?? "";
  return pathValue.trim() || parsed.blockTitle || "(unknown)";
};

const getToolOmittedLineCount = (metadata: Map<string, string>): number => {
  const linesMetadata = metadata.get("lines");
  if (!linesMetadata) {
    return 0;
  }

  const matchedCounts = linesMetadata.match(
    READ_FILE_LINES_WITH_RETURNED_PATTERN
  );
  if (!matchedCounts) {
    return 0;
  }

  const totalLines = Number.parseInt(matchedCounts[1], 10);
  const returnedLines = Number.parseInt(matchedCounts[2], 10);
  if (!(Number.isFinite(totalLines) && Number.isFinite(returnedLines))) {
    return 0;
  }

  const isTruncated = metadata.get("truncated")?.toLowerCase() === "true";
  if (!isTruncated) {
    return 0;
  }

  return Math.max(0, totalLines - returnedLines);
};

const buildReadPreviewLines = (
  visibleLines: string[],
  totalOmitted: number,
  isModelTruncated: boolean
): string[] => {
  const previewLines =
    visibleLines.length > 0 && visibleLines.some((line) => line.length > 0)
      ? [...visibleLines]
      : ["(empty)"];

  if (totalOmitted <= 0) {
    return previewLines;
  }

  const lineLabel = `line${totalOmitted === 1 ? "" : "s"}`;
  previewLines.push("");
  previewLines.push(
    isModelTruncated
      ? `... (${totalOmitted} more ${lineLabel}, truncated)`
      : `... (${totalOmitted} more ${lineLabel})`
  );

  return previewLines;
};

const parseIntegerMetadataValue = (
  rawValue: string | undefined
): number | null => {
  if (!rawValue) {
    return null;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildGlobPreviewLines = (
  visibleLines: string[],
  totalOmitted: number,
  metadata: GlobPreviewMetadata
): string[] => {
  const previewLines =
    visibleLines.length > 0 && visibleLines.some((line) => line.length > 0)
      ? [...visibleLines]
      : ["(no matches)"];

  if (totalOmitted <= 0) {
    return previewLines;
  }

  const lineLabel = `line${totalOmitted === 1 ? "" : "s"}`;

  previewLines.push("");
  previewLines.push(
    metadata.truncated
      ? `... (${totalOmitted} more ${lineLabel}, truncated)`
      : `... (${totalOmitted} more ${lineLabel})`
  );

  return previewLines;
};

const buildGrepPreviewLines = (
  visibleLines: string[],
  totalOmitted: number,
  metadata: GrepPreviewMetadata
): string[] => {
  const previewLines =
    visibleLines.length > 0 && visibleLines.some((line) => line.length > 0)
      ? [...visibleLines]
      : ["(no matches)"];

  if (totalOmitted <= 0) {
    return previewLines;
  }

  const lineLabel = `line${totalOmitted === 1 ? "" : "s"}`;
  const metadataParts = [`path: ${metadata.path ?? "."}`];
  if (metadata.matchCount) {
    metadataParts.push(`match_count (${metadata.matchCount})`);
  }
  if (metadata.truncated) {
    metadataParts.push("truncated: true");
  }

  previewLines.push("");
  previewLines.push(
    metadata.truncated
      ? `... (${totalOmitted} more ${lineLabel}, truncated)`
      : `... (${totalOmitted} more ${lineLabel})`
  );
  previewLines.push(metadataParts.join(", "));

  return previewLines;
};

const renderReadFileOutput = (output: string): ReadFileRenderPayload | null => {
  const parsed = parseReadFileOutput(output);
  if (!parsed) {
    return null;
  }

  const readPath = resolveReadPath(parsed);

  const contentBody =
    parsed.blockBody.trim().length > 0 ? parsed.blockBody : "(empty)";
  const allLines = normalizeHashlineBreakArtifacts(
    contentBody.split("\n").filter(shouldIncludeReadFilePreviewLine)
  );
  const omittedFromPreview = Math.max(
    0,
    allLines.length - MAX_READ_PREVIEW_LINES
  );
  const visibleLines =
    omittedFromPreview > 0
      ? allLines.slice(0, MAX_READ_PREVIEW_LINES)
      : allLines;

  const omittedFromTool = getToolOmittedLineCount(parsed.metadata);
  const isModelTruncated =
    parsed.metadata.get("truncated")?.toLowerCase() === "true";
  const totalOmitted = omittedFromPreview + omittedFromTool;
  const previewLines = buildReadPreviewLines(
    visibleLines,
    totalOmitted,
    isModelTruncated
  );
  const rangeValue = parsed.metadata.get("range")?.trim() || null;

  return {
    path: readPath,
    range: rangeValue,
    body: previewLines.join("\n"),
  };
};

const renderGlobOutput = (output: string): GlobRenderPayload | null => {
  const parsed = parseGlobOutput(output);
  if (!parsed) {
    return null;
  }

  const contentBody = parsed.blockBody.trim();
  const allLines =
    contentBody.length > 0
      ? contentBody.split("\n").filter((line) => line.trim().length > 0)
      : [];

  const omittedFromPreview = Math.max(
    0,
    allLines.length - MAX_READ_PREVIEW_LINES
  );
  const visibleLines =
    omittedFromPreview > 0
      ? allLines.slice(0, MAX_READ_PREVIEW_LINES)
      : allLines;

  const fileCountRaw = parsed.metadata.get("file_count");
  const fileCount = parseIntegerMetadataValue(fileCountRaw);
  const isToolTruncated =
    parsed.metadata.get("truncated")?.toLowerCase() === "true";
  const omittedFromTool =
    isToolTruncated && fileCount !== null
      ? Math.max(0, fileCount - allLines.length)
      : 0;
  const totalOmitted = omittedFromPreview + omittedFromTool;

  const metadata: GlobPreviewMetadata = {
    truncated: isToolTruncated,
  };

  const previewLines = buildGlobPreviewLines(
    visibleLines,
    totalOmitted,
    metadata
  );
  const patternValue =
    stripSurroundedDoubleQuotes(parsed.metadata.get("pattern") ?? "") ||
    parsed.blockTitle ||
    "(unknown)";

  return {
    pattern: patternValue,
    body: previewLines.join("\n"),
  };
};

const renderGrepOutput = (output: string): GrepRenderPayload | null => {
  const parsed = parseGrepOutput(output);
  if (!parsed) {
    return null;
  }

  const contentBody = parsed.blockBody.trim();
  const allLines =
    contentBody.length > 0
      ? normalizeHashlineBreakArtifacts(contentBody.split("\n"))
      : [];

  const omittedFromPreview = Math.max(
    0,
    allLines.length - MAX_READ_PREVIEW_LINES
  );
  const visibleLines =
    omittedFromPreview > 0
      ? allLines.slice(0, MAX_READ_PREVIEW_LINES)
      : allLines;

  const matchCountRaw = parsed.metadata.get("match_count");
  const matchCount = parseIntegerMetadataValue(matchCountRaw);
  const isToolTruncated =
    parsed.metadata.get("truncated")?.toLowerCase() === "true";
  const omittedFromTool =
    isToolTruncated && matchCount !== null
      ? Math.max(0, matchCount - allLines.length)
      : 0;
  const totalOmitted = omittedFromPreview + omittedFromTool;

  const metadata: GrepPreviewMetadata = {
    path: parsed.metadata.get("path") ?? null,
    matchCount: matchCountRaw ?? null,
    truncated: isToolTruncated,
  };

  const previewLines = buildGrepPreviewLines(
    visibleLines,
    totalOmitted,
    metadata
  );

  const patternValue =
    stripSurroundedDoubleQuotes(parsed.metadata.get("pattern") ?? "") ||
    parsed.blockTitle ||
    "(unknown)";

  return {
    pattern: patternValue,
    body: previewLines.join("\n"),
  };
};

const renderPendingOutput = (): string => {
  return TOOL_PENDING_MARKER;
};

const buildPendingSpinnerText = (frame: string): string => {
  return `${frame} ${TOOL_PENDING_MESSAGE}`;
};

const renderToolOutput = (_toolName: string, output: unknown): string => {
  return renderCodeBlock("text", output);
};

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_ITALIC = "\x1b[3m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_BG_GRAY = "\x1b[100m";
const LEADING_NEWLINES = /^\n+/;
const TRAILING_NEWLINES = /\n+$/;

const applyReadPreviewBackground = (text: string): string => {
  return `${ANSI_BG_GRAY}${text}${ANSI_RESET}`;
};

const styleThinkingText = (text: string): string => {
  return `${ANSI_DIM}${ANSI_ITALIC}${ANSI_GRAY}${text}${ANSI_RESET}`;
};

class TrimmedMarkdown extends Markdown {
  override render(width: number): string[] {
    const lines = super.render(width);
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim().length === 0) {
      end -= 1;
    }
    return lines.slice(0, end);
  }
}

class TruncatedReadBody {
  private cachedLines?: string[];
  private cachedText?: string;
  private cachedWidth?: number;
  private readonly background?: (text: string) => string;
  private backgroundEnabled = true;
  private readonly paddingX: number;
  private text: string;

  constructor(
    text: string,
    paddingX: number,
    background?: (text: string) => string
  ) {
    this.text = text;
    this.paddingX = paddingX;
    this.background = background;
  }

  setText(text: string): void {
    this.text = text;
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  setBackgroundEnabled(enabled: boolean): void {
    if (this.backgroundEnabled === enabled) {
      return;
    }
    this.backgroundEnabled = enabled;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (
      this.cachedLines &&
      this.cachedText === this.text &&
      this.cachedWidth === width
    ) {
      return this.cachedLines;
    }

    if (!this.text || this.text.trim().length === 0) {
      this.cachedText = this.text;
      this.cachedWidth = width;
      this.cachedLines = [];
      return [];
    }

    const normalizedText = this.text.replace(TAB_PATTERN, "   ");
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const leftMargin = " ".repeat(this.paddingX);
    const rightMargin = " ".repeat(this.paddingX);

    const renderedLines = normalizedText.split("\n").map((line) => {
      const truncatedLine = truncateToWidth(line, contentWidth, "");
      const lineWithMargins = `${leftMargin}${truncatedLine}${rightMargin}`;
      const visibleLength = visibleWidth(lineWithMargins);
      const paddedLine = `${lineWithMargins}${" ".repeat(Math.max(0, width - visibleLength))}`;

      return this.background && this.backgroundEnabled
        ? this.background(paddedLine)
        : paddedLine;
    });

    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = renderedLines;
    return renderedLines;
  }
}

interface DiffLine {
  text: string;
  type: "add" | "context" | "delete";
}

const MAX_DIFF_MATRIX_CELLS = 60_000;
const MAX_DIFF_RENDER_LINES = 160;

const buildSimpleDiff = (before: string, after: string): DiffLine[] => {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lines: DiffLine[] = [];
  const maxLength = Math.max(beforeLines.length, afterLines.length);

  for (let index = 0; index < maxLength; index += 1) {
    const oldLine = beforeLines[index];
    const newLine = afterLines[index];

    if (oldLine === undefined && newLine !== undefined) {
      lines.push({ type: "add", text: newLine });
      continue;
    }

    if (newLine === undefined && oldLine !== undefined) {
      lines.push({ type: "delete", text: oldLine });
      continue;
    }

    if (oldLine === newLine && oldLine !== undefined) {
      lines.push({ type: "context", text: oldLine });
      continue;
    }

    if (oldLine !== undefined) {
      lines.push({ type: "delete", text: oldLine });
    }
    if (newLine !== undefined) {
      lines.push({ type: "add", text: newLine });
    }
  }

  return lines;
};

const buildLcsDiff = (before: string, after: string): DiffLine[] => {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  if (beforeLines.length === 0 && afterLines.length === 0) {
    return [];
  }

  const matrixCells = (beforeLines.length + 1) * (afterLines.length + 1);
  if (matrixCells > MAX_DIFF_MATRIX_CELLS) {
    return buildSimpleDiff(before, after);
  }

  const lcs: number[][] = new Array(beforeLines.length + 1)
    .fill(undefined)
    .map(() => new Array(afterLines.length + 1).fill(0));

  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      if (beforeLines[i] === afterLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      lines.push({ type: "context", text: beforeLines[i] });
      i += 1;
      j += 1;
      continue;
    }

    if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ type: "delete", text: beforeLines[i] });
      i += 1;
      continue;
    }

    lines.push({ type: "add", text: afterLines[j] });
    j += 1;
  }

  while (i < beforeLines.length) {
    lines.push({ type: "delete", text: beforeLines[i] });
    i += 1;
  }

  while (j < afterLines.length) {
    lines.push({ type: "add", text: afterLines[j] });
    j += 1;
  }

  return lines;
};

const renderDiffBlock = (before: string, after: string): string => {
  const diffLines = buildLcsDiff(before, after);

  const rendered: string[] = ["```diff"];
  for (let index = 0; index < diffLines.length; index += 1) {
    if (index >= MAX_DIFF_RENDER_LINES) {
      rendered.push("... diff truncated ...");
      break;
    }

    const line = diffLines[index];
    if (line.type === "add") {
      rendered.push(`+${line.text}`);
    } else if (line.type === "delete") {
      rendered.push(`-${line.text}`);
    } else {
      rendered.push(` ${line.text}`);
    }
  }
  rendered.push("```");

  return rendered.join("\n");
};

const tryExtractEditPayload = (
  toolName: string,
  input: unknown
): { newStr: string; oldStr: string; path?: string } | null => {
  if (toolName !== "edit_file") {
    return null;
  }

  if (typeof input !== "object" || input === null) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const oldStr = record.old_str;
  const newStr = record.new_str;
  const path = record.path;

  if (typeof oldStr !== "string" || typeof newStr !== "string") {
    return null;
  }

  return {
    oldStr,
    newStr,
    path: typeof path === "string" ? path : undefined,
  };
};

class AssistantStreamView extends Container {
  private readonly markdownTheme: MarkdownTheme;
  private readonly segments: Array<{
    content: string;
    type: "reasoning" | "text";
  }> = [];

  constructor(markdownTheme: MarkdownTheme) {
    super();
    this.markdownTheme = markdownTheme;
    this.refresh();
  }

  appendReasoning(delta: string): void {
    this.appendSegment("reasoning", delta);
  }

  appendText(delta: string): void {
    this.appendSegment("text", delta);
  }

  private appendSegment(type: "reasoning" | "text", delta: string): void {
    if (delta.length === 0) {
      return;
    }

    const lastSegment = this.segments.at(-1);
    if (lastSegment && lastSegment.type === type) {
      lastSegment.content += delta;
    } else {
      this.segments.push({
        type,
        content: delta,
      });
    }

    this.refresh();
  }

  private refresh(): void {
    this.clear();

    const visibleSegments = this.segments
      .map((segment) => {
        const normalizedContent =
          segment.type === "reasoning"
            ? segment.content.replace(LEADING_NEWLINES, "").trimEnd()
            : segment.content.trim();

        return {
          ...segment,
          content: normalizedContent,
        };
      })
      .filter((segment) => segment.content.trim().length > 0);

    if (visibleSegments.length === 0) {
      return;
    }

    for (let index = 0; index < visibleSegments.length; index += 1) {
      const segment = visibleSegments[index];
      const text = segment.content;

      if (segment.type === "text") {
        this.addChild(new Markdown(text, 1, 0, this.markdownTheme));
      } else {
        this.addChild(
          new Markdown(text, 1, 0, this.markdownTheme, {
            color: styleThinkingText,
            italic: true,
          })
        );
      }

      if (index < visibleSegments.length - 1) {
        this.addChild(new Spacer(1));
      }
    }
  }
}

class ToolCallView extends Container {
  private readonly callId: string;
  private readonly content: TrimmedMarkdown;
  private readonly readBlock: Container;
  private readonly readBody: TruncatedReadBody;
  private readonly readHeader: TrimmedMarkdown;
  private readonly requestRender: () => void;
  private readonly showRawToolIo: boolean;
  private error: unknown;
  private finalInput: unknown;
  private inputBuffer = "";
  private output: unknown;
  private outputDenied = false;
  private pendingSpinnerFrameIndex = 0;
  private pendingSpinnerInterval: Timer | null = null;
  private pendingTemplate: string | null = null;
  private parsedInput: unknown;
  private readMode = false;
  private toolName: string;

  constructor(
    callId: string,
    toolName: string,
    markdownTheme: MarkdownTheme,
    requestRender: () => void,
    showRawToolIo: boolean
  ) {
    super();
    this.callId = callId;
    this.toolName = toolName;
    this.requestRender = requestRender;
    this.showRawToolIo = showRawToolIo;
    this.content = new TrimmedMarkdown("", 1, 0, markdownTheme);
    this.readHeader = new TrimmedMarkdown("", 1, 0, markdownTheme);
    this.readBody = new TruncatedReadBody("", 1, applyReadPreviewBackground);
    this.readBlock = new Container();
    this.readBlock.addChild(this.readHeader);
    this.readBlock.addChild(new Spacer(1));
    this.readBlock.addChild(this.readBody);
    this.addChild(this.content);
    this.refresh();
  }

  dispose(): void {
    this.stopPendingSpinner();
  }

  private setReadMode(enabled: boolean): void {
    if (this.readMode === enabled) {
      return;
    }

    this.readMode = enabled;
    this.clear();
    this.addChild(enabled ? this.readBlock : this.content);
  }

  private stopPendingSpinner(): void {
    this.pendingTemplate = null;
    if (!this.pendingSpinnerInterval) {
      return;
    }
    clearInterval(this.pendingSpinnerInterval);
    this.pendingSpinnerInterval = null;
  }

  private applyPendingSpinnerFrame(): void {
    if (!this.pendingTemplate) {
      return;
    }

    const frame = TOOL_PENDING_SPINNER_FRAMES[this.pendingSpinnerFrameIndex];
    this.readBody.setText(
      this.pendingTemplate.replaceAll(
        TOOL_PENDING_MARKER,
        buildPendingSpinnerText(frame)
      )
    );
  }

  private startPendingSpinner(template: string): void {
    this.pendingTemplate = template;
    this.pendingSpinnerFrameIndex = 0;
    this.applyPendingSpinnerFrame();

    if (this.pendingSpinnerInterval) {
      return;
    }

    this.pendingSpinnerInterval = setInterval(() => {
      this.pendingSpinnerFrameIndex =
        (this.pendingSpinnerFrameIndex + 1) %
        TOOL_PENDING_SPINNER_FRAMES.length;
      this.applyPendingSpinnerFrame();
      this.requestRender();
    }, 80);
  }

  async appendInputChunk(chunk: string): Promise<void> {
    this.inputBuffer += chunk;

    const { value, state } = await parsePartialJson(this.inputBuffer);
    const shouldSuppressTransientEmptyObject =
      state !== "successful-parse" && isPlainEmptyObject(value);

    if (!shouldSuppressTransientEmptyObject) {
      this.parsedInput = value;
    }

    this.refresh();
  }

  setError(error: unknown): void {
    this.error = error;
    this.refresh();
  }

  setFinalInput(input: unknown): void {
    this.finalInput = input;
    this.refresh();
  }

  setOutput(output: unknown): void {
    this.output = output;
    this.refresh();
  }

  setOutputDenied(): void {
    this.outputDenied = true;
    this.refresh();
  }

  setToolName(toolName: string): void {
    this.toolName = toolName;
    this.refresh();
  }

  private resolveBestInput(): unknown {
    if (this.finalInput !== undefined) {
      return this.finalInput;
    }
    if (this.parsedInput !== undefined) {
      return this.parsedInput;
    }
    if (this.inputBuffer.length > 0) {
      return this.inputBuffer;
    }
    return undefined;
  }

  private canRenderPrettyTool(toolName: string | Set<string>): boolean {
    if (this.error !== undefined || this.outputDenied) {
      return false;
    }

    if (typeof toolName === "string") {
      return this.toolName === toolName;
    }

    return toolName.has(this.toolName);
  }

  private resolveInputStringField(field: string): string | null {
    const bestInput = this.resolveBestInput();
    const fromObject = extractStringField(bestInput, field);
    if (fromObject) {
      return fromObject;
    }

    return null;
  }

  private resolveInputNumberField(field: string): number | null {
    const bestInput = this.resolveBestInput();
    const fromObject = extractNumberField(bestInput, field);
    if (fromObject !== null) {
      return fromObject;
    }

    return null;
  }

  private setPrettyBlock(
    header: string,
    body: string,
    options?: { isPending?: boolean; useBackground?: boolean }
  ): void {
    this.setReadMode(true);
    this.readBody.setBackgroundEnabled(options?.useBackground ?? true);
    this.readHeader.setText(header);

    if (options?.isPending) {
      this.startPendingSpinner(body);
      return;
    }

    this.stopPendingSpinner();
    this.readBody.setText(body);
  }

  private renderOutputPreviewBody(
    output: unknown,
    emptyText = "(no output)"
  ): string {
    if (typeof output === "string") {
      return buildTextPreviewLines(output, emptyText).join("\n");
    }

    return buildTextPreviewLines(safeStringify(output), emptyText).join("\n");
  }

  private tryRenderReadFileMode(): boolean {
    if (
      this.toolName !== "read_file" ||
      this.error !== undefined ||
      this.outputDenied
    ) {
      return false;
    }

    const readPath = this.resolveInputStringField("path");

    if (typeof this.output === "string") {
      const renderedReadFile = renderReadFileOutput(this.output);
      if (renderedReadFile) {
        const pathWithRange = renderedReadFile.range
          ? `${renderedReadFile.path} ${renderedReadFile.range}`
          : renderedReadFile.path;
        this.setPrettyBlock(
          `**Read** \`${pathWithRange}\``,
          renderedReadFile.body,
          {
            useBackground: true,
          }
        );
      } else {
        const fallbackPath = readPath ?? "(unknown)";
        this.setPrettyBlock(
          `**Read** \`${fallbackPath}\``,
          safeStringify(this.output),
          {
            useBackground: true,
          }
        );
      }
      return true;
    }

    if (!readPath) {
      return false;
    }

    this.setPrettyBlock(`**Read** \`${readPath}\``, renderPendingOutput(), {
      useBackground: false,
      isPending: true,
    });
    return true;
  }

  private tryRenderGlobMode(): boolean {
    if (
      this.toolName !== "glob_files" ||
      this.error !== undefined ||
      this.outputDenied
    ) {
      return false;
    }

    const globPattern = this.resolveInputStringField("pattern");

    if (typeof this.output === "string") {
      const renderedGlob = renderGlobOutput(this.output);
      if (renderedGlob) {
        this.setPrettyBlock(
          `**Glob** \`${renderedGlob.pattern}\``,
          renderedGlob.body,
          {
            useBackground: true,
          }
        );
      } else {
        const fallbackPattern = globPattern ?? "(unknown)";
        this.setPrettyBlock(
          `**Glob** \`${fallbackPattern}\``,
          safeStringify(this.output),
          {
            useBackground: true,
          }
        );
      }
      return true;
    }

    if (!globPattern) {
      return false;
    }

    this.setPrettyBlock(`**Glob** \`${globPattern}\``, renderPendingOutput(), {
      useBackground: false,
      isPending: true,
    });
    return true;
  }

  private tryRenderGrepMode(): boolean {
    if (
      this.toolName !== "grep_files" ||
      this.error !== undefined ||
      this.outputDenied
    ) {
      return false;
    }

    const grepPattern = this.resolveInputStringField("pattern");

    if (typeof this.output === "string") {
      const renderedGrep = renderGrepOutput(this.output);
      if (renderedGrep) {
        this.setPrettyBlock(
          `**Grep** \`${renderedGrep.pattern}\``,
          renderedGrep.body,
          {
            useBackground: true,
          }
        );
      } else {
        const fallbackPattern = grepPattern ?? "(unknown)";
        this.setPrettyBlock(
          `**Grep** \`${fallbackPattern}\``,
          safeStringify(this.output),
          {
            useBackground: true,
          }
        );
      }
      return true;
    }

    if (!grepPattern) {
      return false;
    }

    this.setPrettyBlock(`**Grep** \`${grepPattern}\``, renderPendingOutput(), {
      useBackground: false,
      isPending: true,
    });
    return true;
  }

  private tryRenderShellExecuteMode(): boolean {
    if (!this.canRenderPrettyTool(SHELL_EXECUTE_TOOL_NAMES)) {
      return false;
    }

    const command = this.resolveInputStringField("command") ?? "(command)";
    const header = buildPrettyHeader("Shell", command);

    if (this.output === undefined) {
      this.setPrettyBlock(header, renderPendingOutput(), {
        isPending: true,
        useBackground: false,
      });
      return true;
    }

    const exitCode = extractNumberField(this.output, "exit_code");
    const shellOutput = extractStringField(this.output, "output");
    const workdir = this.resolveInputStringField("workdir");
    const timeoutMs = this.resolveInputNumberField("timeout_ms");

    const bodyLines: string[] = [];
    if (exitCode !== null) {
      bodyLines.push(`exit_code: ${exitCode}`);
    }
    if (workdir) {
      bodyLines.push(`workdir: ${workdir}`);
    }
    if (timeoutMs !== null) {
      bodyLines.push(`timeout_ms: ${timeoutMs}`);
    }
    if (bodyLines.length > 0) {
      bodyLines.push("");
    }

    bodyLines.push(
      ...buildTextPreviewLines(
        shellOutput ?? safeStringify(this.output),
        "(no output)"
      )
    );

    this.setPrettyBlock(header, bodyLines.join("\n"));
    return true;
  }

  private tryRenderShellInteractMode(): boolean {
    if (!this.canRenderPrettyTool("shell_interact")) {
      return false;
    }

    const keystrokes =
      this.resolveInputStringField("keystrokes") ?? "(keystrokes)";
    const header = buildPrettyHeader("Interact", keystrokes);

    if (this.output === undefined) {
      this.setPrettyBlock(header, renderPendingOutput(), {
        isPending: true,
        useBackground: false,
      });
      return true;
    }

    const success = extractBooleanField(this.output, "success");
    const interactOutput = extractStringField(this.output, "output");

    const bodyLines: string[] = [];
    if (success !== null) {
      bodyLines.push(`success: ${success}`);
      bodyLines.push("");
    }

    bodyLines.push(
      ...buildTextPreviewLines(
        interactOutput ?? safeStringify(this.output),
        "(no output)"
      )
    );

    this.setPrettyBlock(header, bodyLines.join("\n"));
    return true;
  }

  private tryRenderWriteFileMode(): boolean {
    if (!this.canRenderPrettyTool("write_file")) {
      return false;
    }

    const bestInput = this.resolveBestInput();
    const path = this.resolveInputStringField("path") ?? "(unknown)";
    const fileContent = extractStringField(bestInput, "content");
    const header = buildPrettyHeader("Write", path);

    if (fileContent !== null) {
      this.setPrettyBlock(header, fileContent, {
        useBackground: true,
      });
      return true;
    }

    if (this.output === undefined) {
      this.setPrettyBlock(header, renderPendingOutput(), {
        isPending: true,
        useBackground: false,
      });
      return true;
    }

    this.setPrettyBlock(header, this.renderOutputPreviewBody(this.output));
    return true;
  }

  private tryRenderEditFileMode(): boolean {
    if (!this.canRenderPrettyTool("edit_file")) {
      return false;
    }

    const bestInput = this.resolveBestInput();
    const path = this.resolveInputStringField("path") ?? "(unknown)";
    const header = buildPrettyHeader("Edit", path);
    const bodyLines: string[] = [];

    if (typeof bestInput === "object" && bestInput !== null) {
      const record = bestInput as Record<string, unknown>;
      if (Array.isArray(record.edits)) {
        bodyLines.push(`edits: ${record.edits.length}`);
      }
    }

    if (this.output === undefined) {
      if (bodyLines.length > 0) {
        bodyLines.push("");
      }
      bodyLines.push(renderPendingOutput());
    } else {
      if (bodyLines.length > 0) {
        bodyLines.push("");
      }
      bodyLines.push(...buildTextPreviewLines(safeStringify(this.output)));
    }

    const editPayload = tryExtractEditPayload(this.toolName, bestInput);
    if (editPayload) {
      bodyLines.push("");
      bodyLines.push("Live diff preview:");
      bodyLines.push(renderDiffBlock(editPayload.oldStr, editPayload.newStr));
    }

    this.setPrettyBlock(header, bodyLines.join("\n"), {
      isPending: this.output === undefined,
      useBackground: this.output !== undefined,
    });
    return true;
  }

  private tryRenderDeleteFileMode(): boolean {
    if (!this.canRenderPrettyTool("delete_file")) {
      return false;
    }

    const path = this.resolveInputStringField("path") ?? "(unknown)";
    const header = buildPrettyHeader("Delete", path);

    if (this.output === undefined) {
      this.setPrettyBlock(header, renderPendingOutput(), {
        isPending: true,
        useBackground: false,
      });
      return true;
    }

    this.setPrettyBlock(header, this.renderOutputPreviewBody(this.output));
    return true;
  }

  private tryRenderLoadSkillMode(): boolean {
    if (!this.canRenderPrettyTool("load_skill")) {
      return false;
    }

    const skillName = this.resolveInputStringField("skillName") ?? "(unknown)";
    const relativePath = this.resolveInputStringField("relativePath");
    const target = relativePath ? `${skillName}/${relativePath}` : skillName;
    const header = buildPrettyHeader("Skill", target);

    if (this.output === undefined) {
      this.setPrettyBlock(header, renderPendingOutput(), {
        isPending: true,
        useBackground: false,
      });
      return true;
    }

    this.setPrettyBlock(header, this.renderOutputPreviewBody(this.output));
    return true;
  }

  private tryRenderTodoWriteMode(): boolean {
    if (!this.canRenderPrettyTool("todo_write")) {
      return false;
    }

    const bestInput = this.resolveBestInput();
    const todoItems =
      typeof bestInput === "object" && bestInput !== null
        ? (bestInput as Record<string, unknown>).todos
        : undefined;
    const todos = Array.isArray(todoItems)
      ? todoItems.filter((item): item is Record<string, unknown> => {
          return typeof item === "object" && item !== null;
        })
      : [];

    const totalTodos = todos.length;
    const headerTarget = `${totalTodos} task${totalTodos === 1 ? "" : "s"}`;
    const header = buildPrettyHeader("Todo", headerTarget);

    if (this.output === undefined) {
      this.setPrettyBlock(header, renderPendingOutput(), {
        isPending: true,
        useBackground: false,
      });
      return true;
    }

    const counts = {
      completed: 0,
      inProgress: 0,
      pending: 0,
      cancelled: 0,
    };

    for (const todo of todos) {
      const status =
        typeof todo.status === "string" ? todo.status.toLowerCase() : "";
      if (status === "completed") {
        counts.completed += 1;
      } else if (status === "in_progress") {
        counts.inProgress += 1;
      } else if (status === "pending") {
        counts.pending += 1;
      } else if (status === "cancelled") {
        counts.cancelled += 1;
      }
    }

    const bodyLines = [
      `total: ${totalTodos}`,
      `completed: ${counts.completed}`,
      `in_progress: ${counts.inProgress}`,
      `pending: ${counts.pending}`,
      `cancelled: ${counts.cancelled}`,
      "",
      ...buildTextPreviewLines(safeStringify(this.output)),
    ];

    this.setPrettyBlock(header, bodyLines.join("\n"));
    return true;
  }

  private tryRenderPrettyMode(): boolean {
    return (
      this.tryRenderReadFileMode() ||
      this.tryRenderGlobMode() ||
      this.tryRenderGrepMode() ||
      this.tryRenderShellExecuteMode() ||
      this.tryRenderShellInteractMode() ||
      this.tryRenderWriteFileMode() ||
      this.tryRenderEditFileMode() ||
      this.tryRenderDeleteFileMode() ||
      this.tryRenderLoadSkillMode() ||
      this.tryRenderTodoWriteMode()
    );
  }

  private shouldSuppressRawFallback(): boolean {
    if (this.showRawToolIo) {
      return false;
    }

    return (
      this.finalInput === undefined &&
      this.output === undefined &&
      this.error === undefined &&
      !this.outputDenied &&
      this.inputBuffer.length > 0
    );
  }

  private refresh(): void {
    if (!this.showRawToolIo && this.tryRenderPrettyMode()) {
      return;
    }

    this.stopPendingSpinner();

    if (this.shouldSuppressRawFallback()) {
      return;
    }

    this.setReadMode(false);

    const includeCallIdInRawHeader = !SHELL_TOOL_NAMES.has(this.toolName);
    const rawHeader = includeCallIdInRawHeader
      ? `**Tool** \`${this.toolName}\` (\`${this.callId}\`)`
      : `**Tool** \`${this.toolName}\``;

    const blocks: string[] = [rawHeader];

    const bestInput = this.resolveBestInput();
    if (bestInput !== undefined) {
      blocks.push(`**Input**\n\n${renderCodeBlock("json", bestInput)}`);

      const editPayload = tryExtractEditPayload(this.toolName, bestInput);
      if (editPayload) {
        const heading = editPayload.path
          ? `**Live diff preview** (\`${editPayload.path}\`)`
          : "**Live diff preview**";
        blocks.push(
          `${heading}\n\n${renderDiffBlock(editPayload.oldStr, editPayload.newStr)}`
        );
      }
    }

    if (this.output !== undefined) {
      blocks.push(
        `**Output**\n\n${renderToolOutput(this.toolName, this.output)}`
      );
    }

    if (this.error !== undefined) {
      blocks.push(`**Error**\n\n${renderCodeBlock("text", this.error)}`);
    }

    if (this.outputDenied) {
      blocks.push("**Output** denied by model/policy");
    }

    this.content.setText(blocks.join("\n\n"));
  }
}

const getToolInputId = (part: ToolInputPart): string | undefined => {
  return part.id ?? part.toolCallId;
};

const getToolInputChunk = (part: ToolInputDeltaPart): string | null => {
  if (typeof part.delta === "string") {
    return part.delta;
  }

  if (typeof part.inputTextDelta === "string") {
    return part.inputTextDelta;
  }

  return null;
};

const createToolInputState = (toolName: string): ToolInputRenderState => {
  return {
    toolName,
    hasContent: false,
    inputBuffer: "",
    renderedInputLength: 0,
  };
};

const syncToolInputToView = async (
  state: PiTuiStreamState,
  toolCallId: string,
  toolState: ToolInputRenderState
): Promise<void> => {
  const hasKnownToolName = toolState.toolName !== UNKNOWN_TOOL_NAME;
  if (!(state.flags.showRawToolIo || hasKnownToolName)) {
    return;
  }

  const existingView = state.getToolView(toolCallId);
  const pendingInput = toolState.inputBuffer.slice(
    toolState.renderedInputLength
  );
  if (!existingView && pendingInput.length === 0) {
    return;
  }

  state.resetAssistantView(true);
  const toolView =
    existingView ?? state.ensureToolView(toolCallId, toolState.toolName);

  if (pendingInput.length === 0) {
    return;
  }

  await toolView.appendInputChunk(pendingInput);
  toolState.renderedInputLength = toolState.inputBuffer.length;
};

const createInfoMessage = (title: string, value: unknown): Text => {
  return new Text(`${title}\n${safeStringify(value)}`, 1, 0);
};

interface PiTuiRenderFlags {
  showFiles: boolean;
  showFinishReason: boolean;
  showRawToolIo: boolean;
  showReasoning: boolean;
  showSources: boolean;
  showSteps: boolean;
  showToolResults: boolean;
}

interface PiTuiStreamState {
  activeToolInputs: Map<string, ToolInputRenderState>;
  chatContainer: Container;
  ensureAssistantView: () => AssistantStreamView;
  ensureToolView: (toolCallId: string, toolName: string) => ToolCallView;
  flags: PiTuiRenderFlags;
  getToolView: (toolCallId: string) => ToolCallView | undefined;
  resetAssistantView: (suppressLeadingSpacer?: boolean) => void;
  streamedToolCallIds: Set<string>;
}

type StreamPartHandler = (
  part: StreamPart,
  state: PiTuiStreamState
) => void | Promise<void>;

const handleTextStart: StreamPartHandler = (_part, state) => {
  state.ensureAssistantView();
};

const handleTextDelta: StreamPartHandler = (part, state) => {
  const textPart = part as Extract<StreamPart, { type: "text-delta" }>;
  state.ensureAssistantView().appendText(textPart.text);
};

const handleReasoningStart: StreamPartHandler = (_part, state) => {
  if (state.flags.showReasoning) {
    state.ensureAssistantView();
  }
};

const handleReasoningDelta: StreamPartHandler = (part, state) => {
  if (!state.flags.showReasoning) {
    return;
  }
  const reasoningPart = part as Extract<
    StreamPart,
    { type: "reasoning-delta" }
  >;
  state.ensureAssistantView().appendReasoning(reasoningPart.text);
};

const handleToolInputStart: StreamPartHandler = async (part, state) => {
  const toolInputStartPart = part as Extract<
    StreamPart,
    { type: "tool-input-start" }
  >;
  const toolCallId = getToolInputId(toolInputStartPart);
  if (!toolCallId) {
    return;
  }

  const existingState = state.activeToolInputs.get(toolCallId);
  const toolState =
    existingState ?? createToolInputState(toolInputStartPart.toolName);
  toolState.toolName = toolInputStartPart.toolName;

  state.activeToolInputs.set(toolCallId, toolState);
  state.streamedToolCallIds.add(toolCallId);
  await syncToolInputToView(state, toolCallId, toolState);
};

const handleToolInputDelta: StreamPartHandler = async (part, state) => {
  const toolInputDeltaPart = part as Extract<
    StreamPart,
    { type: "tool-input-delta" }
  >;
  const toolCallId = getToolInputId(toolInputDeltaPart);
  if (!toolCallId) {
    return;
  }

  if (!state.activeToolInputs.has(toolCallId)) {
    state.activeToolInputs.set(
      toolCallId,
      createToolInputState(UNKNOWN_TOOL_NAME)
    );
  }

  const toolState = state.activeToolInputs.get(toolCallId);
  const chunk = getToolInputChunk(toolInputDeltaPart);

  if (chunk && toolState) {
    toolState.inputBuffer += chunk;
    toolState.hasContent = true;
    await syncToolInputToView(state, toolCallId, toolState);
  }

  state.streamedToolCallIds.add(toolCallId);
};

const handleToolInputEnd: StreamPartHandler = (part, state) => {
  const toolInputEndPart = part as Extract<
    StreamPart,
    { type: "tool-input-end" }
  >;
  const toolCallId = getToolInputId(toolInputEndPart);
  if (toolCallId) {
    state.streamedToolCallIds.add(toolCallId);
  }
};

const handleToolCall: StreamPartHandler = (part, state) => {
  const toolCallPart = part as Extract<StreamPart, { type: "tool-call" }>;
  const inputState = state.activeToolInputs.get(toolCallPart.toolCallId);
  const shouldSkipToolCallRender =
    state.streamedToolCallIds.has(toolCallPart.toolCallId) &&
    inputState?.hasContent === true;

  state.activeToolInputs.delete(toolCallPart.toolCallId);
  state.streamedToolCallIds.delete(toolCallPart.toolCallId);

  state.resetAssistantView(true);
  const view = state.ensureToolView(
    toolCallPart.toolCallId,
    toolCallPart.toolName
  );
  view.setFinalInput(toolCallPart.input);

  if (!shouldSkipToolCallRender) {
    view.setToolName(toolCallPart.toolName);
  }
};

const handleToolResult: StreamPartHandler = (part, state) => {
  if (!state.flags.showToolResults) {
    return;
  }

  const toolResultPart = part as Extract<StreamPart, { type: "tool-result" }>;
  state.resetAssistantView(true);
  const view = state.ensureToolView(
    toolResultPart.toolCallId,
    toolResultPart.toolName
  );
  view.setOutput(toolResultPart.output);
};

const handleToolError: StreamPartHandler = (part, state) => {
  const toolErrorPart = part as Extract<StreamPart, { type: "tool-error" }>;
  state.resetAssistantView(true);
  const view = state.ensureToolView(
    toolErrorPart.toolCallId,
    toolErrorPart.toolName
  );
  view.setError(toolErrorPart.error);
};

const handleToolOutputDenied: StreamPartHandler = (part, state) => {
  const deniedPart = part as Extract<
    StreamPart,
    { type: "tool-output-denied" }
  >;
  state.resetAssistantView(true);
  const view = state.ensureToolView(deniedPart.toolCallId, deniedPart.toolName);
  view.setOutputDenied();
};

const handleStartStep: StreamPartHandler = (_part, state) => {
  if (!state.flags.showSteps) {
    return;
  }
  state.resetAssistantView();
  addChatComponent(state.chatContainer, createInfoMessage("[step start]", ""));
};

const handleFinishStep: StreamPartHandler = (part, state) => {
  if (!state.flags.showSteps) {
    return;
  }
  const finishStepPart = part as Extract<StreamPart, { type: "finish-step" }>;
  state.resetAssistantView();
  addChatComponent(
    state.chatContainer,
    createInfoMessage("[step finish]", finishStepPart.finishReason)
  );
};

const handleSource: StreamPartHandler = (part, state) => {
  if (!state.flags.showSources) {
    return;
  }
  state.resetAssistantView();
  addChatComponent(state.chatContainer, createInfoMessage("[source]", part));
};

const handleFile: StreamPartHandler = (part, state) => {
  if (!state.flags.showFiles) {
    return;
  }
  const filePart = part as Extract<StreamPart, { type: "file" }>;
  state.resetAssistantView();
  addChatComponent(
    state.chatContainer,
    createInfoMessage("[file]", filePart.file)
  );
};

const handleFinish: StreamPartHandler = (part, state) => {
  if (!state.flags.showFinishReason) {
    return;
  }

  const finishPart = part as Extract<StreamPart, { type: "finish" }>;
  state.resetAssistantView();
  addChatComponent(
    state.chatContainer,
    createInfoMessage("[finish]", finishPart.finishReason ?? "unknown")
  );
};

const STREAM_HANDLERS: Record<string, StreamPartHandler> = {
  "text-start": handleTextStart,
  "text-delta": handleTextDelta,
  "reasoning-start": handleReasoningStart,
  "reasoning-delta": handleReasoningDelta,
  "tool-input-start": handleToolInputStart,
  "tool-input-delta": handleToolInputDelta,
  "tool-input-end": handleToolInputEnd,
  "tool-call": handleToolCall,
  "tool-result": handleToolResult,
  "tool-error": handleToolError,
  "tool-output-denied": handleToolOutputDenied,
  "start-step": handleStartStep,
  "finish-step": handleFinishStep,
  source: handleSource,
  file: handleFile,
  finish: handleFinish,
};

const IGNORE_PART_TYPES = new Set([
  "abort",
  "text-end",
  "reasoning-end",
  "start",
  "tool-approval-request",
]);

const isVisibleStreamPart = (
  part: StreamPart,
  flags: PiTuiRenderFlags
): boolean => {
  switch (part.type) {
    case "abort":
    case "text-end":
    case "reasoning-end":
    case "start":
    case "tool-approval-request":
    case "text-start":
    case "reasoning-start":
    case "tool-input-end":
      return false;
    case "reasoning-delta":
      return flags.showReasoning;
    case "tool-result":
      return flags.showToolResults;
    case "start-step":
    case "finish-step":
      return flags.showSteps;
    case "source":
      return flags.showSources;
    case "file":
      return flags.showFiles;
    case "finish":
      return flags.showFinishReason;
    default:
      return true;
  }
};

const handleStreamPart = async (
  part: StreamPart,
  state: PiTuiStreamState
): Promise<void> => {
  const handler = STREAM_HANDLERS[part.type];
  if (handler) {
    await handler(part, state);
    return;
  }

  if (IGNORE_PART_TYPES.has(part.type)) {
    return;
  }

  state.resetAssistantView();
  addChatComponent(
    state.chatContainer,
    createInfoMessage("[unknown part]", part)
  );
};

export const renderFullStreamWithPiTui = async <TOOLS extends ToolSet>(
  stream: AsyncIterable<TextStreamPart<TOOLS>>,
  options: PiTuiStreamRenderOptions
): Promise<void> => {
  const flags: PiTuiRenderFlags = {
    showReasoning: options.showReasoning ?? true,
    showSteps: options.showSteps ?? false,
    showFinishReason: options.showFinishReason ?? false,
    showRawToolIo: options.showRawToolIo ?? isRawToolIoEnabledByEnv(),
    showToolResults: options.showToolResults ?? true,
    showSources: options.showSources ?? false,
    showFiles: options.showFiles ?? false,
  };

  const activeToolInputs = new Map<string, ToolInputRenderState>();
  const streamedToolCallIds = new Set<string>();
  const toolViews = new Map<string, ToolCallView>();
  let assistantView: AssistantStreamView | null = null;
  let suppressAssistantLeadingSpacer = false;
  let firstVisiblePartSeen = false;

  const resetAssistantView = (suppressLeadingSpacer = false): void => {
    if (suppressLeadingSpacer) {
      suppressAssistantLeadingSpacer = true;
    }
    assistantView = null;
  };

  const ensureAssistantView = (): AssistantStreamView => {
    if (!assistantView) {
      assistantView = new AssistantStreamView(options.markdownTheme);
      addChatComponent(options.chatContainer, assistantView, {
        addLeadingSpacer: !suppressAssistantLeadingSpacer,
      });
      suppressAssistantLeadingSpacer = false;
    }
    return assistantView;
  };

  const ensureToolView = (
    toolCallId: string,
    toolName: string
  ): ToolCallView => {
    const existing = toolViews.get(toolCallId);
    if (existing) {
      existing.setToolName(toolName);
      return existing;
    }

    const view = new ToolCallView(
      toolCallId,
      toolName,
      options.markdownTheme,
      () => options.ui.requestRender(),
      flags.showRawToolIo
    );
    toolViews.set(toolCallId, view);
    addChatComponent(options.chatContainer, view);
    return view;
  };

  const state: PiTuiStreamState = {
    flags,
    activeToolInputs,
    streamedToolCallIds,
    resetAssistantView,
    ensureAssistantView,
    ensureToolView,
    getToolView: (toolCallId: string) => toolViews.get(toolCallId),
    chatContainer: options.chatContainer,
  };

  try {
    for await (const rawPart of stream) {
      const part = rawPart as StreamPart;

      if (!firstVisiblePartSeen && isVisibleStreamPart(part, flags)) {
        firstVisiblePartSeen = true;
        options.onFirstVisiblePart?.();
      }

      await handleStreamPart(part, state);
      options.ui.requestRender();
    }
  } finally {
    for (const view of toolViews.values()) {
      view.dispose();
    }
  }
};
