const SINGLE_LINE_SPLIT_REGEX = /\r?\n/;
const ANCHOR_PREFIX_REGEX = /^\s*(\d+\s*#\s*[ZPMQVRWSNKTXJBYH]{2})/i;
const KEY_VALUE_IN_POS_REGEX = /['"]lines['"\s]*:/;
const XML_MARKUP_IN_POS_REGEX = /<\/?parameter/;
const EMBEDDED_END_REGEX =
  /['"']?end['"']?\s*[:=]\s*['"']?(\d+\s*#\s*[ZPMQVRWSNKTXJBYH]{2})['"']?/i;

export interface HashlineToolEdit {
  end?: string;
  lines?: string[] | string | null;
  op: "append" | "prepend" | "replace";
  pos?: string;
}

export interface RepairResult {
  edit: HashlineToolEdit;
  warnings: string[];
}

export function assertSingleLineAnchor(
  anchor: string | undefined,
  fieldName: "pos" | "end"
): void {
  if (!anchor) {
    return;
  }
  if (anchor.includes("\n") || anchor.includes("\r")) {
    const lineCount = anchor.split(SINGLE_LINE_SPLIT_REGEX).length;
    throw new Error(
      `${fieldName} contains ${lineCount} lines — must be a single-line {line_number}#{hash_id} anchor.`
    );
  }
}

function tryParseEmbeddedValue(raw: string): string[] | null | undefined {
  const trimmed = raw.trim();

  if (/^null\s*[})]?\s*$/.test(trimmed)) {
    return null;
  }

  const arrayMatch = trimmed.match(/^\[([^\]]*)\]/);
  if (arrayMatch) {
    const inner = arrayMatch[1].trim();
    if (inner.length === 0) {
      return [];
    }
    const elements = inner.split(/,\s*/).map((el) => {
      const s = el.trim();
      const unquoted = s.replace(/^['"]|['"]$/g, "");
      return unquoted;
    });
    return elements;
  }

  const stringMatch = trimmed.match(/^['"](.*)['"]/);
  if (stringMatch) {
    return [stringMatch[1]];
  }

  return undefined;
}

function tryExtractEmbeddedLines(
  posAfterAnchor: string
): string[] | null | undefined {
  const kvMatch = posAfterAnchor.match(
    /['"]?lines['"]?\s*[:=]\s*(.+?)\s*[})]?\s*$/
  );
  if (kvMatch) {
    return tryParseEmbeddedValue(kvMatch[1]);
  }

  const qsMatch = posAfterAnchor.match(/[&?]\s*lines\s*[:=]\s*(.+?)\s*$/);
  if (qsMatch) {
    return tryParseEmbeddedValue(qsMatch[1]);
  }

  return undefined;
}

function tryExtractEmbeddedEnd(rest: string): string | undefined {
  const endMatch = rest.match(EMBEDDED_END_REGEX);
  if (!endMatch) {
    return undefined;
  }
  return endMatch[1].replace(/\s*#\s*/, "#");
}

function repairAnchorField(
  raw: string | undefined
): { cleanAnchor: string; rest: string } | null {
  if (!raw) {
    return null;
  }
  if (raw.includes("\n") || raw.includes("\r")) {
    return null;
  }
  const anchorMatch = raw.match(ANCHOR_PREFIX_REGEX);
  if (!anchorMatch) {
    return null;
  }
  const cleanAnchor = anchorMatch[1].replace(/\s*#\s*/, "#");
  const rest = raw.slice(anchorMatch[0].length);
  if (rest.trim().length === 0) {
    return null;
  }
  return { cleanAnchor, rest };
}

export function repairMalformedEdit(edit: HashlineToolEdit): RepairResult {
  const warnings: string[] = [];
  let repairedPos = edit.pos;
  let repairedEnd = edit.end;
  let repairedLines = edit.lines;

  const posRepair = repairAnchorField(edit.pos);
  if (posRepair) {
    repairedPos = posRepair.cleanAnchor;
    warnings.push(
      `Auto-repaired pos: extracted anchor '${posRepair.cleanAnchor}' from malformed value.`
    );

    if (edit.lines === undefined) {
      const extractedLines = tryExtractEmbeddedLines(posRepair.rest);
      if (extractedLines !== undefined) {
        repairedLines = extractedLines;
        warnings.push(
          "Auto-repaired lines: extracted embedded content from pos field."
        );
      } else {
        const plainContent = posRepair.rest.replace(/^[|=%:,;]\s*/, "").trim();
        const looksLikeGarbage = /^['"]?[\]})>]|<\/|<\w+>|^\s*}/.test(
          plainContent
        );
        if (plainContent.length > 0 && !looksLikeGarbage) {
          repairedLines = plainContent.split("\n");
          warnings.push(
            `Auto-repaired lines: extracted trailing content '${plainContent.slice(0, 60)}' from pos as replacement text.`
          );
        }
      }
    }
  }

  const endRepair = repairAnchorField(edit.end);
  if (endRepair) {
    repairedEnd = endRepair.cleanAnchor;
    warnings.push(
      `Auto-repaired end: extracted anchor '${endRepair.cleanAnchor}' from malformed value.`
    );
  }

  if (repairedEnd === undefined && posRepair) {
    const extractedEnd = tryExtractEmbeddedEnd(posRepair.rest);
    if (extractedEnd) {
      repairedEnd = extractedEnd;
      warnings.push(
        `Auto-repaired end: extracted anchor '${extractedEnd}' from embedded content in pos.`
      );
    }
  }

  if (warnings.length === 0) {
    return { edit, warnings };
  }

  return {
    edit: {
      ...edit,
      pos: repairedPos,
      end: repairedEnd,
      lines: repairedLines,
    },
    warnings,
  };
}
