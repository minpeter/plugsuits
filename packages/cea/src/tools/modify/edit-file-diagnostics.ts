import { computeLineHash, tryParseLineTag } from "../utils/hashline";

const ANCHOR_HASH_EXTRACT_REGEX = /#([ZPMQVRWSNKTXJBYH]{2})/i;
const NUMERIC_LINE_PREFIX_REGEX = /^\d+$/;
const HASHLINE_ALPHABET_PREFIX_REGEX = /^[ZPMQVRWSNKTXJBYH]{2}/i;
const ANCHOR_PREFIX_REGEX = /^\s*(\d+\s*#\s*[ZPMQVRWSNKTXJBYH]{2})/i;
const KEY_VALUE_IN_POS_REGEX = /['"]lines['"\s]*:/;
const XML_MARKUP_IN_POS_REGEX = /<\/?parameter/;
const POS_DISPLAY_MAX_LENGTH = 80;

const missingLinesFailures = new Map<string, number>();
const missingLinesFileFailures = new Map<string, number>();
export const ESCALATION_THRESHOLD = 2;
export const ESCALATION_EXAMPLE_THRESHOLD = 4;
export const ESCALATION_BAIL_THRESHOLD = 6;
export const FILE_BAIL_THRESHOLD = 10;

export function trackMissingLinesFailure(
  pos: string | undefined,
  filePath?: string
): number {
  if (filePath) {
    const fileCount = (missingLinesFileFailures.get(filePath) ?? 0) + 1;
    missingLinesFileFailures.set(filePath, fileCount);
  }
  if (!pos) {
    return 1;
  }
  const key = pos.trim();
  const count = (missingLinesFailures.get(key) ?? 0) + 1;
  missingLinesFailures.set(key, count);
  return count;
}

export function resetMissingLinesFailures(): void {
  missingLinesFailures.clear();
  missingLinesFileFailures.clear();
}

export function getMissingLinesFailureCount(pos: string): number {
  return missingLinesFailures.get(pos) ?? 0;
}

export function getFileFailureCount(filePath: string): number {
  return missingLinesFileFailures.get(filePath) ?? 0;
}

export function suggestLineForHash(
  raw: string,
  fileLines: string[]
): string | null {
  const hashMatch = raw.match(ANCHOR_HASH_EXTRACT_REGEX);
  if (!hashMatch) {
    return null;
  }
  const hash = hashMatch[1].toUpperCase();
  for (let i = 0; i < fileLines.length; i += 1) {
    if (computeLineHash(i + 1, fileLines[i] ?? "") === hash) {
      return `Did you mean "${i + 1}#${hash}"?`;
    }
  }
  return null;
}

export function diagnoseAnchorFailure(
  raw: string,
  fieldName: string,
  fileLines?: string[]
): string {
  const hashIdx = raw.indexOf("#");
  let message: string;

  if (hashIdx > 0) {
    const prefix = raw.slice(0, hashIdx).trim();
    const suffix = raw.slice(hashIdx + 1).trim();

    if (!NUMERIC_LINE_PREFIX_REGEX.test(prefix)) {
      message = `${fieldName} "${raw}": "${prefix}" is not a line number. Use the actual line number from read_file output.`;
    } else if (HASHLINE_ALPHABET_PREFIX_REGEX.test(suffix)) {
      message = `${fieldName} "${raw}" is not a valid {line_number}#{hash_id} anchor.`;
    } else {
      message = `${fieldName} "${raw}": hash portion "${suffix}" is not valid. Hash must be 2 characters from the hashline alphabet.`;
    }
  } else {
    message = `${fieldName} "${raw}" is not a valid {line_number}#{hash_id} anchor — missing # separator.`;
  }

  if (fileLines && fileLines.length > 0) {
    const hint = suggestLineForHash(raw, fileLines);
    if (hint) {
      message += ` ${hint}`;
    }
  }

  return message;
}

export function diagnoseMissingLines(pos: string | undefined): string {
  const base = "replace requires explicit 'lines' field.";

  if (!pos || pos.trim().length === 0) {
    return base;
  }

  const truncated =
    pos.length > POS_DISPLAY_MAX_LENGTH
      ? `${pos.slice(0, POS_DISPLAY_MAX_LENGTH - 3)}...`
      : pos;

  if (KEY_VALUE_IN_POS_REGEX.test(pos)) {
    return `${base} Detected key-value syntax in pos — 'pos' and 'lines' must be separate JSON fields.`;
  }

  if (XML_MARKUP_IN_POS_REGEX.test(pos)) {
    return `${base} Detected XML markup in pos — use JSON fields: pos for anchor, lines for content.`;
  }

  const anchorMatch = pos.match(ANCHOR_PREFIX_REGEX);
  if (anchorMatch) {
    const anchorText = anchorMatch[1].replace(/\s*#\s*/, "#");
    const rest = pos.slice(anchorMatch[0].length);
    if (rest.trim().length > 0) {
      return `${base} pos contains content after anchor '${anchorText}' — move replacement text to 'lines'.`;
    }
    return `${base} Add 'lines' with the replacement content for anchor '${anchorText}'.`;
  }

  return `${base} pos should contain only a {line_number}#{hash_id} anchor, not content. Got: "${truncated}".`;
}

export function getEscalatedHint(
  pos: string | undefined,
  fileLines: string[],
  failureCount: number
): string | null {
  if (!pos || fileLines.length === 0) {
    return null;
  }
  const parsed = tryParseLineTag(pos);
  if (!parsed) {
    return null;
  }
  const lineIndex = parsed.line - 1;
  if (lineIndex < 0 || lineIndex >= fileLines.length) {
    return null;
  }
  const content = fileLines[lineIndex];
  const anchor = `${parsed.line}#${parsed.hash}`;

  if (failureCount >= ESCALATION_EXAMPLE_THRESHOLD) {
    return `STOP REPEATING (attempt ${failureCount}). You MUST include 'lines' as a separate JSON field. Correct format: {"op":"replace","pos":"${anchor}","lines":["your replacement text"]}. Current line ${parsed.line} contains: '${content}'.`;
  }

  return `Line ${parsed.line} currently contains '${content}'. Set lines to the replacement content.`;
}

export function buildEscalationBailMessage(
  edits: Array<{ pos?: string; end?: string }>,
  filePath: string,
  fileLines: string[]
): string | null {
  const anchorBail = edits.some((e) => {
    const pos = e.pos?.trim();
    return pos && getMissingLinesFailureCount(pos) >= ESCALATION_BAIL_THRESHOLD;
  });
  const fileBail = getFileFailureCount(filePath) >= FILE_BAIL_THRESHOLD;
  if (!(anchorBail || fileBail)) {
    return null;
  }

  const failingEdit =
    edits.find((e) => {
      const pos = e.pos?.trim();
      return pos && getMissingLinesFailureCount(pos) >= ESCALATION_BAIL_THRESHOLD;
    }) ?? edits.find((e) => e.pos?.trim());
  const anchor = failingEdit?.pos?.trim() ?? "";
  const parsedTag = tryParseLineTag(anchor);
  const lineContent = parsedTag && fileLines[parsedTag.line - 1];
  const anchorFailCount = getMissingLinesFailureCount(anchor);
  const fileFailCount = getFileFailureCount(filePath);
  const failCount = Math.max(anchorFailCount, fileFailCount);

  const parts: string[] = [
    `⚠️ edit_file: NOT APPLIED (attempt ${failCount}) — 'lines' field is missing.`,
    "",
    `Your input: {"op": "replace", "pos": "${anchor}"}`,
    `The file ${filePath} was NOT changed.`,
    "",
    `To replace this line, you MUST include 'lines' as a separate JSON field:`,
    `  {"op": "replace", "pos": "${anchor}", "lines": ["your new content here"]}`,
  ];

  if (lineContent !== undefined && lineContent !== null) {
    parts.push("", `Line ${parsedTag?.line} currently contains: "${lineContent}"`);
  }

  parts.push(
    "",
    `To delete this line: {"op": "replace", "pos": "${anchor}", "lines": []}`,
    "Alternatively, use write_file to replace the entire file content."
  );

  return parts.join("\n");
}
