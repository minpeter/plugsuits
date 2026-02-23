export interface LineTag {
  hash: string;
  line: number;
}

export interface HashMismatch {
  actual: string;
  expected: string;
  line: number;
}

export type HashlineEdit =
  | {
      op: "append";
      lines: string[];
      pos?: LineTag;
    }
  | {
      op: "prepend";
      lines: string[];
      pos?: LineTag;
    }
  | {
      op: "replace";
      end?: LineTag;
      lines: string[];
      pos: LineTag;
    };

export interface HashlineNoopEdit {
  current: string;
  editIndex: number;
  loc: string;
}

export interface ApplyHashlineEditsResult {
  firstChangedLine: number | undefined;
  lines: string;
  noopEdits?: HashlineNoopEdit[];
  warnings?: string[];
}

const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";
const HASH_DICT = Array.from({ length: 256 }, (_, i) => {
  const high = Math.floor(i / 16);
  const low = i % 16;
  return `${NIBBLE_STR[high]}${NIBBLE_STR[low]}`;
});

const SIGNIFICANT_CHAR_REGEX = /[\p{L}\p{N}]/u;
const TAG_REGEX = /^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/i;
const EMBEDDED_TAG_REGEX =
  /[:-]\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/i;
const HASHLINE_PREFIX_REGEX =
  /^\s*(?:>>>|>>)?\s*\d+\s*#\s*[ZPMQVRWSNKTXJBYH]{2}\s*(?:[:|])\s*/i;
const DIFF_PLUS_REGEX = /^[+](?![+])/;

export function computeLineHash(lineNumber: number, lineText: string): string {
  let normalized = lineText;
  if (normalized.endsWith("\r")) {
    normalized = normalized.slice(0, -1);
  }
  normalized = normalized.replace(/\s+/g, "");

  let seed = 0;
  if (!SIGNIFICANT_CHAR_REGEX.test(normalized)) {
    seed = lineNumber;
  }

  const rawHash = Bun.hash.xxHash32(normalized, seed);
  const index = ((rawHash % 256) + 256) % 256;
  return HASH_DICT[index];
}

export function computeFileHash(content: string): string {
  const rawHash = Bun.hash.xxHash32(content, 0);
  const normalized =
    ((rawHash % 0x1_00_00_00_00) + 0x1_00_00_00_00) % 0x1_00_00_00_00;
  return normalized.toString(16).padStart(8, "0");
}

export function formatLineTag(lineNumber: number, lineText: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, lineText)}`;
}

export function parseLineTag(tag: string): LineTag {
  const matched = tag.match(TAG_REGEX) ?? tag.match(EMBEDDED_TAG_REGEX);
  if (!matched) {
    throw new Error(
      `Invalid line reference "${tag}". Expected "LINE#ID" (example: "5#AB") or a grep line containing it.`
    );
  }

  const lineNumber = Number.parseInt(matched[1], 10);
  if (lineNumber < 1) {
    throw new Error(`Line number must be >= 1, got ${lineNumber} in "${tag}".`);
  }

  return {
    line: lineNumber,
    hash: matched[2].toUpperCase(),
  };
}

export function stripNewLinePrefixes(lines: string[]): string[] {
  let hashPrefixCount = 0;
  let diffPlusCount = 0;
  let nonEmptyLines = 0;

  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    nonEmptyLines += 1;
    if (HASHLINE_PREFIX_REGEX.test(line)) {
      hashPrefixCount += 1;
    }
    if (DIFF_PLUS_REGEX.test(line)) {
      diffPlusCount += 1;
    }
  }

  if (nonEmptyLines === 0) {
    return lines;
  }

  const shouldStripHashlinePrefixes =
    hashPrefixCount > 0 && hashPrefixCount >= nonEmptyLines * 0.5;
  const shouldStripDiffPrefix =
    !shouldStripHashlinePrefixes &&
    diffPlusCount > 0 &&
    diffPlusCount >= nonEmptyLines * 0.5;

  if (!(shouldStripHashlinePrefixes || shouldStripDiffPrefix)) {
    return lines;
  }

  return lines.map((line) => {
    if (shouldStripHashlinePrefixes) {
      return line.replace(HASHLINE_PREFIX_REGEX, "");
    }
    if (shouldStripDiffPrefix) {
      return line.replace(DIFF_PLUS_REGEX, "");
    }
    return line;
  });
}

export function parseHashlineText(
  input: string[] | string | null | undefined
): string[] {
  if (input === null || input === undefined) {
    return [];
  }
  if (Array.isArray(input)) {
    return input;
  }

  const lines = stripNewLinePrefixes(input.split("\n"));
  if (lines.length === 0) {
    return [];
  }
  if (lines.at(-1)?.trim() === "") {
    return lines.slice(0, -1);
  }
  return lines;
}

function formatMismatchMessage(
  mismatches: HashMismatch[],
  fileLines: string[]
): string {
  const mismatchByLine = new Map<number, HashMismatch>();
  for (const mismatch of mismatches) {
    mismatchByLine.set(mismatch.line, mismatch);
  }

  const CONTEXT = 2;
  const displayLines = new Set<number>();
  for (const mismatch of mismatches) {
    const min = Math.max(1, mismatch.line - CONTEXT);
    const max = Math.min(fileLines.length, mismatch.line + CONTEXT);
    for (let line = min; line <= max; line += 1) {
      displayLines.add(line);
    }
  }

  const sorted = [...displayLines].sort((a, b) => a - b);
  const output: string[] = [];
  output.push(
    `${mismatches.length} line${mismatches.length === 1 ? "" : "s"} changed since last read. Use updated LINE#ID references (>>> marks changed lines).`
  );
  output.push("");

  let previousLine = -1;
  for (const lineNumber of sorted) {
    if (previousLine !== -1 && lineNumber > previousLine + 1) {
      output.push("    ...");
    }
    previousLine = lineNumber;

    const text = fileLines[lineNumber - 1] ?? "";
    const prefix = `${lineNumber}#${computeLineHash(lineNumber, text)}`;
    const marker = mismatchByLine.has(lineNumber) ? ">>>" : "   ";
    output.push(`${marker} ${prefix}:${text}`);
  }

  return output.join("\n");
}

export class HashlineMismatchError extends Error {
  readonly mismatches: readonly HashMismatch[];

  constructor(mismatches: HashMismatch[], fileLines: string[]) {
    super(formatMismatchMessage(mismatches, fileLines));
    this.name = "HashlineMismatchError";
    this.mismatches = mismatches;
  }
}

function isSameText(linesA: string[], linesB: string[]): boolean {
  if (linesA.length !== linesB.length) {
    return false;
  }
  for (let index = 0; index < linesA.length; index += 1) {
    if (linesA[index] !== linesB[index]) {
      return false;
    }
  }
  return true;
}

function ensureLineTagValid(
  tag: LineTag,
  lines: string[],
  mismatches: HashMismatch[]
): boolean {
  if (tag.line < 1 || tag.line > lines.length) {
    throw new Error(
      `Line ${tag.line} does not exist (file has ${lines.length} lines).`
    );
  }

  const actualHash = computeLineHash(tag.line, lines[tag.line - 1] ?? "");
  if (actualHash === tag.hash.toUpperCase()) {
    return true;
  }

  mismatches.push({
    line: tag.line,
    expected: tag.hash.toUpperCase(),
    actual: actualHash,
  });
  return false;
}

function dedupeMismatches(mismatches: HashMismatch[]): HashMismatch[] {
  const seenByLine = new Map<number, HashMismatch>();
  for (const mismatch of mismatches) {
    if (!seenByLine.has(mismatch.line)) {
      seenByLine.set(mismatch.line, mismatch);
    }
  }
  return [...seenByLine.values()].sort((a, b) => a.line - b.line);
}

function validateEditsAgainstFile(
  edits: HashlineEdit[],
  fileLines: string[]
): void {
  const mismatches: HashMismatch[] = [];

  for (const edit of edits) {
    switch (edit.op) {
      case "replace": {
        const startValid = ensureLineTagValid(edit.pos, fileLines, mismatches);
        const endValid = edit.end
          ? ensureLineTagValid(edit.end, fileLines, mismatches)
          : true;

        if (
          startValid &&
          endValid &&
          edit.end &&
          edit.pos.line > edit.end.line
        ) {
          throw new Error(
            `Range start line ${edit.pos.line} must be <= end line ${edit.end.line}.`
          );
        }
        break;
      }
      case "append": {
        if (edit.pos) {
          ensureLineTagValid(edit.pos, fileLines, mismatches);
        }
        break;
      }
      case "prepend": {
        if (edit.pos) {
          ensureLineTagValid(edit.pos, fileLines, mismatches);
        }
        break;
      }
      default: {
        throw new Error("Unsupported hashline operation.");
      }
    }
  }

  if (mismatches.length > 0) {
    throw new HashlineMismatchError(dedupeMismatches(mismatches), fileLines);
  }
}

interface AnnotatedHashlineEdit {
  edit: HashlineEdit;
  editIndex: number;
  precedence: number;
  sortLine: number;
}

function buildAnnotatedEdits(
  edits: HashlineEdit[],
  fileLines: string[]
): AnnotatedHashlineEdit[] {
  const seenEditKeys = new Set<string>();
  const deduped: HashlineEdit[] = [];

  for (const edit of edits) {
    const key = JSON.stringify(edit);
    if (seenEditKeys.has(key)) {
      continue;
    }
    seenEditKeys.add(key);
    deduped.push(edit);
  }

  const annotated = deduped.map((edit, editIndex) => {
    if (edit.op === "replace") {
      return {
        edit,
        editIndex,
        precedence: 0,
        sortLine: edit.end?.line ?? edit.pos.line,
      };
    }

    if (edit.op === "append") {
      return {
        edit,
        editIndex,
        precedence: 1,
        sortLine: edit.pos?.line ?? fileLines.length + 1,
      };
    }

    return {
      edit,
      editIndex,
      precedence: 2,
      sortLine: edit.pos?.line ?? 0,
    };
  });

  annotated.sort((a, b) => {
    if (a.sortLine !== b.sortLine) {
      return b.sortLine - a.sortLine;
    }
    if (a.precedence !== b.precedence) {
      return a.precedence - b.precedence;
    }
    if (a.precedence === 1 || a.precedence === 2) {
      return b.editIndex - a.editIndex;
    }
    return a.editIndex - b.editIndex;
  });

  return annotated;
}

function applyAnnotatedEdit(params: {
  annotated: AnnotatedHashlineEdit;
  fileLines: string[];
  originalLines: string[];
  noopEdits: HashlineNoopEdit[];
  trackFirstChangedLine: (lineNumber: number) => void;
}): void {
  const {
    annotated,
    fileLines,
    originalLines,
    noopEdits,
    trackFirstChangedLine,
  } = params;
  const { edit, editIndex } = annotated;

  if (edit.op === "replace") {
    const startIndex = edit.pos.line - 1;
    const replaceCount = edit.end ? edit.end.line - edit.pos.line + 1 : 1;
    const currentSlice = originalLines.slice(
      startIndex,
      startIndex + replaceCount
    );

    if (isSameText(currentSlice, edit.lines)) {
      noopEdits.push({
        editIndex,
        loc: `${edit.pos.line}#${edit.pos.hash}`,
        current: currentSlice.join("\n"),
      });
      return;
    }

    fileLines.splice(startIndex, replaceCount, ...edit.lines);
    trackFirstChangedLine(edit.pos.line);
    return;
  }

  const insertedLines = edit.lines.length === 0 ? [""] : edit.lines;
  if (edit.op === "append") {
    if (edit.pos) {
      fileLines.splice(edit.pos.line, 0, ...insertedLines);
      trackFirstChangedLine(edit.pos.line + 1);
      return;
    }

    if (fileLines.length === 1 && fileLines[0] === "") {
      fileLines.splice(0, 1, ...insertedLines);
      trackFirstChangedLine(1);
      return;
    }

    const hasTrailingNewlineSentinel = fileLines.at(-1) === "";
    const insertionIndex = hasTrailingNewlineSentinel
      ? Math.max(fileLines.length - 1, 0)
      : fileLines.length;
    const startLine = insertionIndex + 1;
    fileLines.splice(insertionIndex, 0, ...insertedLines);
    trackFirstChangedLine(startLine);
    return;
  }

  if (edit.pos) {
    fileLines.splice(edit.pos.line - 1, 0, ...insertedLines);
    trackFirstChangedLine(edit.pos.line);
    return;
  }

  if (fileLines.length === 1 && fileLines[0] === "") {
    fileLines.splice(0, 1, ...insertedLines);
    trackFirstChangedLine(1);
    return;
  }

  fileLines.splice(0, 0, ...insertedLines);
  trackFirstChangedLine(1);
}

export function applyHashlineEdits(
  content: string,
  edits: HashlineEdit[]
): ApplyHashlineEditsResult {
  if (edits.length === 0) {
    return {
      lines: content,
      firstChangedLine: undefined,
    };
  }

  const fileLines = content.split("\n");
  const originalLines = [...fileLines];
  validateEditsAgainstFile(edits, fileLines);
  const annotated = buildAnnotatedEdits(edits, fileLines);

  let firstChangedLine: number | undefined;
  const noopEdits: HashlineNoopEdit[] = [];

  const trackFirstChangedLine = (lineNumber: number): void => {
    if (firstChangedLine === undefined || lineNumber < firstChangedLine) {
      firstChangedLine = lineNumber;
    }
  };

  for (const annotatedEdit of annotated) {
    applyAnnotatedEdit({
      annotated: annotatedEdit,
      fileLines,
      originalLines,
      noopEdits,
      trackFirstChangedLine,
    });
  }

  const warnings =
    noopEdits.length > 0
      ? [
          `${noopEdits.length} edit(s) were no-ops because replacement text matched existing content.`,
        ]
      : undefined;

  return {
    lines: fileLines.join("\n"),
    firstChangedLine,
    ...(noopEdits.length > 0 ? { noopEdits } : {}),
    ...(warnings ? { warnings } : {}),
  };
}

export function formatHashlineNumberedLines(
  lines: string[],
  startLine: number
): string {
  return lines
    .map((line, index) => {
      const lineNumber = startLine + index;
      const tag = formatLineTag(lineNumber, line);
      return `  ${tag} | ${line}`;
    })
    .join("\n");
}
