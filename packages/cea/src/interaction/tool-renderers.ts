import type { BaseToolCallView, ToolRendererMap } from "@ai-sdk-tool/tui";

const READ_FILE_SUCCESS_PREFIX = "OK - read file";
const GLOB_SUCCESS_PREFIX = "OK - glob";
const GREP_SUCCESS_PREFIX = "OK - grep";
const MAX_READ_PREVIEW_LINES = 10;
const MAX_WRITE_FILE_PREVIEW_LINES = 200;
const MAX_WRITE_FILE_PREVIEW_CHARS = 100_000;
const MAX_DIFF_MATRIX_CELLS = 60_000;
const MAX_DIFF_RENDER_LINES = 160;

const READ_FILE_BLOCK_PREFIX = "======== ";
const READ_FILE_BLOCK_SUFFIX = " ========";
const READ_FILE_BLOCK_END = "======== end ========";
const READ_FILE_LINE_SPLIT_PATTERN = /^(\s*\d+(?:#[^\s|]+)?\s*\|\s*)(.*)$/;
const READ_FILE_LINES_WITH_RETURNED_PATTERN = /^(\d+)\s+\(returned:\s*(\d+)\)$/;
const READ_FILE_MARKDOWN_FENCE_PATTERN = /^(?:`{3,}|~{3,}).*$/;
const SURROUNDED_BY_DOUBLE_QUOTES_PATTERN = /^"(.*)"$/;
const HASHLINE_TAG_ONLY_PATTERN = /^(.*\d+#[ZPMQVRWSNKTXJBYH]{2})\s*$/;
const HASHLINE_PIPE_ONLY_PATTERN = /^\|\s*(.*)$/;
const HASHLINE_TAG_PIPE_ONLY_PATTERN =
  /^(.*\d+#[ZPMQVRWSNKTXJBYH]{2})\s*\|\s*$/;
const HASHLINE_COMPACT_LINE_PATTERN = /^\s*\d+#[ZPMQVRWSNKTXJBYH]{2}\|.*$/;

interface ParsedBlockOutput {
  blockBody: string;
  blockTitle: string;
  metadata: Map<string, string>;
}

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

interface DiffLine {
  text: string;
  type: "add" | "context" | "delete";
}

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

const buildPrettyHeader = (title: string, target: string): string =>
  `**${title}** \`${target}\``;

const buildTextPreviewLines = (
  text: string,
  emptyText = "(empty)",
  maxPreviewLines = MAX_READ_PREVIEW_LINES
): string[] => {
  const normalized = text.replaceAll("\r\n", "\n").trimEnd();
  if (normalized.length === 0) {
    return [emptyText];
  }

  const allLines = normalized.split("\n");
  const omittedLines = Math.max(0, allLines.length - maxPreviewLines);
  const visibleLines =
    omittedLines > 0 ? allLines.slice(0, maxPreviewLines) : allLines;

  const preview = [...visibleLines];
  if (omittedLines > 0) {
    const lineLabel = `line${omittedLines === 1 ? "" : "s"}`;
    preview.push("");
    preview.push(`... (${omittedLines} more ${lineLabel})`);
  }

  return preview;
};

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
): ParsedBlockOutput | null => {
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

  return { metadata, blockTitle, blockBody };
};

const parseReadFileOutput = (output: string): ParsedBlockOutput | null =>
  parseNumberedBlockToolOutput(output, READ_FILE_SUCCESS_PREFIX);

const parseGlobOutput = (output: string): ParsedBlockOutput | null =>
  parseNumberedBlockToolOutput(output, GLOB_SUCCESS_PREFIX);

const parseGrepOutput = (output: string): ParsedBlockOutput | null =>
  parseNumberedBlockToolOutput(output, GREP_SUCCESS_PREFIX);

const resolveReadPath = (parsed: ParsedBlockOutput): string => {
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

const parseIntegerMetadataValue = (
  rawValue: string | undefined
): number | null => {
  if (!rawValue) {
    return null;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : null;
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

const renderOutputPreviewBody = (
  output: unknown,
  emptyText = "(no output)"
): string => {
  if (typeof output === "string") {
    return buildTextPreviewLines(output, emptyText).join("\n");
  }
  return buildTextPreviewLines(safeStringify(output), emptyText).join("\n");
};

const tryExtractEditPayload = (
  input: unknown
): { newStr: string; oldStr: string; path?: string } | null => {
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

const handlePendingState = (
  view: BaseToolCallView,
  header: string
): boolean => {
  view.setPrettyBlock(header, "", {
    isPending: true,
    useBackground: false,
  });
  return true;
};

const handleErrorState = (view: BaseToolCallView, header: string): boolean => {
  const error = view.getError();
  if (error === undefined) {
    return false;
  }
  view.setPrettyBlock(header, safeStringify(error), {
    useBackground: true,
    isError: true,
  });
  return true;
};

const renderReadFile = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  const readPath = extractStringField(input, "path") ?? "(unknown)";
  const header = buildPrettyHeader("Read", readPath);

  if (handleErrorState(view, header)) {
    return;
  }

  if (output === undefined) {
    handlePendingState(view, header);
    return;
  }

  if (typeof output === "string") {
    const rendered = renderReadFileOutput(output);
    if (rendered) {
      const pathWithRange = rendered.range
        ? `${rendered.path} ${rendered.range}`
        : rendered.path;
      view.setPrettyBlock(
        buildPrettyHeader("Read", pathWithRange),
        rendered.body,
        { useBackground: true }
      );
    } else {
      view.setPrettyBlock(header, safeStringify(output), {
        useBackground: true,
      });
    }
    return;
  }

  view.setPrettyBlock(header, renderOutputPreviewBody(output));
};

const renderGlob = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  const globPattern = extractStringField(input, "pattern") ?? "(unknown)";
  const header = buildPrettyHeader("Glob", globPattern);

  if (handleErrorState(view, header)) {
    return;
  }

  if (output === undefined) {
    handlePendingState(view, header);
    return;
  }

  if (typeof output === "string") {
    const rendered = renderGlobOutput(output);
    if (rendered) {
      view.setPrettyBlock(
        buildPrettyHeader("Glob", rendered.pattern),
        rendered.body,
        { useBackground: true }
      );
    } else {
      view.setPrettyBlock(header, safeStringify(output), {
        useBackground: true,
      });
    }
    return;
  }

  view.setPrettyBlock(header, renderOutputPreviewBody(output));
};

const renderGrep = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  const grepPattern = extractStringField(input, "pattern") ?? "(unknown)";
  const header = buildPrettyHeader("Grep", grepPattern);

  if (handleErrorState(view, header)) {
    return;
  }

  if (output === undefined) {
    handlePendingState(view, header);
    return;
  }

  if (typeof output === "string") {
    const rendered = renderGrepOutput(output);
    if (rendered) {
      view.setPrettyBlock(
        buildPrettyHeader("Grep", rendered.pattern),
        rendered.body,
        { useBackground: true }
      );
    } else {
      view.setPrettyBlock(header, safeStringify(output), {
        useBackground: true,
      });
    }
    return;
  }

  view.setPrettyBlock(header, renderOutputPreviewBody(output));
};

const renderShellExecute = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  const command = extractStringField(input, "command") ?? "(command)";
  const header = buildPrettyHeader("Shell", command);

  if (handleErrorState(view, header)) {
    return;
  }

  if (output === undefined) {
    handlePendingState(view, header);
    return;
  }

  const exitCode = extractNumberField(output, "exit_code");
  const shellOutput = extractStringField(output, "output");
  const workdir = extractStringField(input, "workdir");
  const timeoutMs = extractNumberField(input, "timeout_ms");

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
      shellOutput ?? safeStringify(output),
      "(no output)"
    )
  );

  view.setPrettyBlock(header, bodyLines.join("\n"));
};

const renderShellInteract = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  const keystrokes = extractStringField(input, "keystrokes") ?? "(keystrokes)";
  const header = buildPrettyHeader("Interact", keystrokes);

  if (handleErrorState(view, header)) {
    return;
  }

  if (output === undefined) {
    handlePendingState(view, header);
    return;
  }

  const success = extractBooleanField(output, "success");
  const interactOutput = extractStringField(output, "output");

  const bodyLines: string[] = [];
  if (success !== null) {
    bodyLines.push(`success: ${success}`);
    bodyLines.push("");
  }

  bodyLines.push(
    ...buildTextPreviewLines(
      interactOutput ?? safeStringify(output),
      "(no output)"
    )
  );

  view.setPrettyBlock(header, bodyLines.join("\n"));
};

const renderWriteFile = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  const path = extractStringField(input, "path") ?? "(unknown)";
  const fileContent = extractStringField(input, "content");
  const header = buildPrettyHeader("Write", path);

  if (handleErrorState(view, header)) {
    return;
  }

  const hasVisibleFileContent =
    fileContent !== null && fileContent.trim().length > 0;

  if (hasVisibleFileContent) {
    const boundedContent =
      fileContent.length > MAX_WRITE_FILE_PREVIEW_CHARS
        ? fileContent.slice(0, MAX_WRITE_FILE_PREVIEW_CHARS)
        : fileContent;
    const previewBody = buildTextPreviewLines(
      boundedContent,
      "(empty)",
      MAX_WRITE_FILE_PREVIEW_LINES
    ).join("\n");

    view.setPrettyBlock(header, previewBody, { useBackground: true });
    return;
  }

  if (output === undefined) {
    handlePendingState(view, header);
    return;
  }

  view.setPrettyBlock(header, renderOutputPreviewBody(output));
};

const renderEditFile = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  const path = extractStringField(input, "path") ?? "(unknown)";
  const header = buildPrettyHeader("Edit", path);

  if (handleErrorState(view, header)) {
    return;
  }

  const bodyLines: string[] = [];

  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    if (Array.isArray(record.edits)) {
      bodyLines.push(`edits: ${record.edits.length}`);
    }
  }

  if (output === undefined) {
    if (bodyLines.length > 0) {
      bodyLines.push("");
    }
    bodyLines.push(PENDING_MARKER_TEXT);
  } else {
    if (bodyLines.length > 0) {
      bodyLines.push("");
    }
    bodyLines.push(...buildTextPreviewLines(safeStringify(output)));
  }

  const editPayload = tryExtractEditPayload(input);
  if (editPayload) {
    bodyLines.push("");
    bodyLines.push("Live diff preview:");
    bodyLines.push(renderDiffBlock(editPayload.oldStr, editPayload.newStr));
  }

  view.setPrettyBlock(header, bodyLines.join("\n"), {
    isPending: output === undefined,
    useBackground: output !== undefined,
  });
};

const renderDeleteFile = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  const path = extractStringField(input, "path") ?? "(unknown)";
  const header = buildPrettyHeader("Delete", path);

  if (handleErrorState(view, header)) {
    return;
  }

  if (output === undefined) {
    handlePendingState(view, header);
    return;
  }

  view.setPrettyBlock(header, renderOutputPreviewBody(output));
};

const renderLoadSkill = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  const skillName = extractStringField(input, "skillName") ?? "(unknown)";
  const relativePath = extractStringField(input, "relativePath");
  const target = relativePath ? `${skillName}/${relativePath}` : skillName;
  const header = buildPrettyHeader("Skill", target);

  if (handleErrorState(view, header)) {
    return;
  }

  if (output === undefined) {
    handlePendingState(view, header);
    return;
  }

  view.setPrettyBlock(header, renderOutputPreviewBody(output));
};

const renderTodoWrite = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  const todoItems =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).todos
      : undefined;
  const todos = Array.isArray(todoItems)
    ? todoItems.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null
      )
    : [];

  const totalTodos = todos.length;
  const headerTarget = `${totalTodos} task${totalTodos === 1 ? "" : "s"}`;
  const header = buildPrettyHeader("Todo", headerTarget);

  if (handleErrorState(view, header)) {
    return;
  }

  if (output === undefined) {
    handlePendingState(view, header);
    return;
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
    ...buildTextPreviewLines(safeStringify(output)),
  ];

  view.setPrettyBlock(header, bodyLines.join("\n"));
};

const PENDING_MARKER_TEXT = "__tool_pending_status__";

export const createToolRenderers = (): ToolRendererMap => ({
  read_file: renderReadFile,
  glob_files: renderGlob,
  grep_files: renderGrep,
  shell_execute: renderShellExecute,
  bash: renderShellExecute,
  shell_interact: renderShellInteract,
  write_file: renderWriteFile,
  edit_file: renderEditFile,
  delete_file: renderDeleteFile,
  load_skill: renderLoadSkill,
  todo_write: renderTodoWrite,
});
