import { computeFileHash } from "../utils/hashline/hash-computation";
import type { HashlineEdit } from "../utils/hashline/types";
import { tryParseLineTag } from "../utils/hashline/validation";
import {
  diagnoseAnchorFailure,
  diagnoseMissingLines,
  ESCALATION_THRESHOLD,
  getEscalatedHint,
  trackMissingLinesFailure,
} from "./edit-file-diagnostics";
import {
  assertSingleLineAnchor,
  type HashlineToolEdit,
  repairMalformedEdit,
} from "./edit-file-repair";

type ParsedLineTag = ReturnType<typeof tryParseLineTag>;

function assertEditAnchorsAreSingleLine(edit: HashlineToolEdit): void {
  assertSingleLineAnchor(edit.pos, "pos");
  assertSingleLineAnchor(edit.end, "end");
}

function throwMissingReplaceLinesError(
  edit: HashlineToolEdit,
  fileLines: string[],
  filePath: string
): never {
  const failureCount = trackMissingLinesFailure(edit.pos, filePath);
  const baseMessage = diagnoseMissingLines(edit.pos);
  const hint =
    failureCount >= ESCALATION_THRESHOLD && fileLines.length > 0
      ? getEscalatedHint(edit.pos, fileLines, failureCount)
      : null;

  if (hint) {
    throw new Error(`${baseMessage} ${hint}`);
  }

  throw new Error(baseMessage);
}

function ensureReplaceEditHasLines(
  edit: HashlineToolEdit,
  fileLines: string[],
  filePath: string
): void {
  if (edit.op !== "replace" || edit.lines !== undefined) {
    return;
  }

  throwMissingReplaceLinesError(edit, fileLines, filePath);
}

function parseEditAnchors(edit: HashlineToolEdit): {
  parsedPos: ParsedLineTag;
  parsedEnd: ParsedLineTag;
} {
  return {
    parsedPos: tryParseLineTag(edit.pos),
    parsedEnd: tryParseLineTag(edit.end),
  };
}

function throwReplaceAnchorFailure(
  edit: HashlineToolEdit,
  fileLines: string[]
): never {
  if (edit.pos) {
    throw new Error(diagnoseAnchorFailure(edit.pos, "pos", fileLines));
  }

  if (edit.end) {
    throw new Error(diagnoseAnchorFailure(edit.end, "end", fileLines));
  }

  throw new Error("replace requires pos or end anchor.");
}

function pushFallbackToEndWarning(
  originalEdit: HashlineToolEdit,
  repairWarnings: string[],
  isReplace: boolean
): void {
  if (isReplace && originalEdit.pos === undefined) {
    repairWarnings.push("pos was not provided; falling back to end anchor.");
    return;
  }

  repairWarnings.push(
    `Ignored invalid pos "${originalEdit.pos}"; falling back to end anchor.`
  );
}

function pushFallbackToPosWarning(
  originalEdit: HashlineToolEdit,
  repairWarnings: string[]
): void {
  repairWarnings.push(
    `Ignored invalid end "${originalEdit.end}"; falling back to pos anchor.`
  );
}

function validateReplaceAnchors(
  repairedEdit: HashlineToolEdit,
  originalEdit: HashlineToolEdit,
  parsedPos: ParsedLineTag,
  parsedEnd: ParsedLineTag,
  fileLines: string[],
  repairWarnings: string[]
): HashlineToolEdit {
  if (!(parsedPos || parsedEnd)) {
    throwReplaceAnchorFailure(repairedEdit, fileLines);
  }

  if (!parsedPos && parsedEnd) {
    pushFallbackToEndWarning(originalEdit, repairWarnings, true);
    return { ...repairedEdit, pos: undefined };
  }

  if (parsedPos && !parsedEnd && repairedEdit.end) {
    pushFallbackToPosWarning(originalEdit, repairWarnings);
    return { ...repairedEdit, end: undefined };
  }

  return repairedEdit;
}

function maybeThrowAppendPrependAnchorFailure(
  repairedEdit: HashlineToolEdit,
  fileLines: string[]
): void {
  const failedField = repairedEdit.pos ? "pos" : "end";
  const failedValue = repairedEdit.pos ?? repairedEdit.end;

  if (!failedValue) {
    return;
  }

  throw new Error(diagnoseAnchorFailure(failedValue, failedField, fileLines));
}

function validateAppendPrependAnchors(
  repairedEdit: HashlineToolEdit,
  originalEdit: HashlineToolEdit,
  parsedPos: ParsedLineTag,
  parsedEnd: ParsedLineTag,
  fileLines: string[],
  repairWarnings: string[]
): HashlineToolEdit {
  if ((repairedEdit.pos || repairedEdit.end) && !parsedPos && !parsedEnd) {
    maybeThrowAppendPrependAnchorFailure(repairedEdit, fileLines);
    return repairedEdit;
  }

  if (!parsedPos && parsedEnd) {
    pushFallbackToEndWarning(originalEdit, repairWarnings, false);
    return { ...repairedEdit, pos: repairedEdit.end, end: undefined };
  }

  if (parsedPos && !parsedEnd && repairedEdit.end) {
    pushFallbackToPosWarning(originalEdit, repairWarnings);
    return { ...repairedEdit, end: undefined };
  }

  return repairedEdit;
}

export function validateAndRepairEdits(
  edits: HashlineToolEdit[],
  fileLines: string[],
  filePath: string
): { edits: HashlineToolEdit[]; repairWarnings: string[] } {
  const repairWarnings: string[] = [];
  const validated: HashlineToolEdit[] = [];

  for (const edit of edits) {
    let { edit: repairedEdit, warnings } = repairMalformedEdit(edit);
    repairWarnings.push(...warnings);

    assertEditAnchorsAreSingleLine(repairedEdit);
    ensureReplaceEditHasLines(repairedEdit, fileLines, filePath);

    const { parsedPos, parsedEnd } = parseEditAnchors(repairedEdit);
    repairedEdit =
      repairedEdit.op === "replace"
        ? validateReplaceAnchors(
            repairedEdit,
            edit,
            parsedPos,
            parsedEnd,
            fileLines,
            repairWarnings
          )
        : validateAppendPrependAnchors(
            repairedEdit,
            edit,
            parsedPos,
            parsedEnd,
            fileLines,
            repairWarnings
          );

    validated.push(repairedEdit);
  }

  return { edits: validated, repairWarnings };
}

export function canCreateFromMissingFile(edits: HashlineEdit[]): boolean {
  if (edits.length === 0) {
    return false;
  }
  return edits.every((edit) => edit.op === "append" || edit.op === "prepend");
}

export function assertExpectedFileHash(
  expectedHash: string | undefined,
  currentContent: string
): void {
  if (!expectedHash) {
    return;
  }
  const normalizedExpected = expectedHash.toLowerCase();
  const currentHash = computeFileHash(currentContent).toLowerCase();
  if (normalizedExpected !== currentHash) {
    throw new Error(
      `File changed since read_file output. expected=${normalizedExpected}, current=${currentHash}`
    );
  }
}
