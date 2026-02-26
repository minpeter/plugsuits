import {
  computeFileHash,
  type HashlineEdit,
  tryParseLineTag,
} from "../utils/hashline";
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: complex validation pipeline
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

    assertSingleLineAnchor(repairedEdit.pos, "pos");
    assertSingleLineAnchor(repairedEdit.end, "end");

    if (repairedEdit.op === "replace" && repairedEdit.lines === undefined) {
      const failureCount = trackMissingLinesFailure(repairedEdit.pos, filePath);
      const baseMessage = diagnoseMissingLines(repairedEdit.pos);
      if (failureCount >= ESCALATION_THRESHOLD && fileLines.length > 0) {
        const hint = getEscalatedHint(
          repairedEdit.pos,
          fileLines,
          failureCount
        );
        if (hint) {
          throw new Error(`${baseMessage} ${hint}`);
        }
      }
      throw new Error(baseMessage);
    }

    const parsedPos = tryParseLineTag(repairedEdit.pos);
    const parsedEnd = tryParseLineTag(repairedEdit.end);

    if (repairedEdit.op === "replace") {
      if (!(parsedPos || parsedEnd)) {
        if (repairedEdit.pos) {
          throw new Error(
            diagnoseAnchorFailure(repairedEdit.pos, "pos", fileLines)
          );
        }
        if (repairedEdit.end) {
          throw new Error(
            diagnoseAnchorFailure(repairedEdit.end, "end", fileLines)
          );
        }
        throw new Error("replace requires pos or end anchor.");
      }
      // Fallback: clear invalid anchors so normalize uses the valid one
      if (!parsedPos && parsedEnd) {
        repairedEdit = { ...repairedEdit, pos: undefined };
        repairWarnings.push(
          edit.pos === undefined
            ? "Moved end anchor to pos (pos was not provided)."
            : `Ignored invalid pos "${edit.pos}"; falling back to end anchor.`
        );
      } else if (parsedPos && !parsedEnd && repairedEdit.end) {
        repairedEdit = { ...repairedEdit, end: undefined };
        repairWarnings.push(
          `Ignored invalid end "${edit.end}"; falling back to pos anchor.`
        );
      }
    } else if (
      (repairedEdit.pos || repairedEdit.end) &&
      !parsedPos &&
      !parsedEnd
    ) {
      const failedField = repairedEdit.pos ? "pos" : "end";
      const failedValue = repairedEdit.pos ?? repairedEdit.end;
      if (failedValue) {
        throw new Error(
          diagnoseAnchorFailure(failedValue, failedField, fileLines)
        );
      }
    } else if (!parsedPos && parsedEnd) {
      // For append/prepend: fall back to end when pos is invalid
      repairedEdit = { ...repairedEdit, pos: repairedEdit.end, end: undefined };
      repairWarnings.push(
        `Ignored invalid pos "${edit.pos}"; falling back to end anchor.`
      );
    } else if (parsedPos && !parsedEnd && repairedEdit.end) {
      repairedEdit = { ...repairedEdit, end: undefined };
      repairWarnings.push(
        `Ignored invalid end "${edit.end}"; falling back to pos anchor.`
      );
    }

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
