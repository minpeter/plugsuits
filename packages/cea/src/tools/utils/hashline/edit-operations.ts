import { dedupeEdits } from "./edit-deduplication";
import {
  applyAppend,
  applyInsertAfter,
  applyInsertBefore,
  applyPrepend,
  applyReplaceLines,
  applySetLine,
} from "./edit-operation-primitives";
import {
  collectLineRefs,
  detectOverlappingRanges,
  getEditLineNumber,
} from "./edit-ordering";
import type { HashlineEdit } from "./types";
import { validateLineRefs } from "./validation";

/** Compare two string arrays element-by-element. O(n) with early exit. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

const SKIP_VALIDATION = { skipValidation: true };

function computeEditResult(edit: HashlineEdit, lines: string[]): string[] {
  switch (edit.op) {
    case "replace": {
      return edit.end
        ? applyReplaceLines(
            lines,
            edit.pos,
            edit.end,
            edit.lines,
            SKIP_VALIDATION
          )
        : applySetLine(lines, edit.pos, edit.lines, SKIP_VALIDATION);
    }
    case "append": {
      return edit.pos
        ? applyInsertAfter(lines, edit.pos, edit.lines, SKIP_VALIDATION)
        : applyAppend(lines, edit.lines);
    }
    case "prepend": {
      return edit.pos
        ? applyInsertBefore(lines, edit.pos, edit.lines, SKIP_VALIDATION)
        : applyPrepend(lines, edit.lines);
    }
    default: {
      return lines;
    }
  }
}

export interface HashlineApplyReport {
  content: string;
  deduplicatedEdits: number;
  noopEdits: number;
}

export function applyHashlineEditsWithReport(
  content: string,
  edits: HashlineEdit[]
): HashlineApplyReport {
  if (edits.length === 0) {
    return {
      content,
      noopEdits: 0,
      deduplicatedEdits: 0,
    };
  }

  const EDIT_PRECEDENCE: Record<string, number> = {
    replace: 0,
    append: 1,
    prepend: 2,
  };
  const sortedEdits = [...edits].sort((a, b) => {
    const lineA = getEditLineNumber(a);
    const lineB = getEditLineNumber(b);
    if (lineB !== lineA) {
      return lineB - lineA;
    }
    return (EDIT_PRECEDENCE[a.op] ?? 3) - (EDIT_PRECEDENCE[b.op] ?? 3);
  });

  const dedupeResult = dedupeEdits(sortedEdits);
  const uniqueEdits = dedupeResult.edits;

  let noopEdits = 0;

  let lines = content.length === 0 ? [] : content.split("\n");

  const refs = collectLineRefs(uniqueEdits);
  validateLineRefs(lines, refs);

  const overlapError = detectOverlappingRanges(uniqueEdits);
  if (overlapError) {
    throw new Error(overlapError);
  }

  for (const edit of uniqueEdits) {
    const next = computeEditResult(edit, lines);
    if (arraysEqual(next, lines)) {
      noopEdits += 1;
    } else {
      lines = next;
    }
  }

  return {
    content: lines.join("\n"),
    noopEdits,
    deduplicatedEdits: dedupeResult.deduplicatedEdits,
  };
}

export function applyHashlineEdits(
  content: string,
  edits: HashlineEdit[]
): string {
  return applyHashlineEditsWithReport(content, edits).content;
}
