const CONTINUATION_TOKEN_REGEX =
  /(?:&&|\|\||\?\?|\?|:|=|,|\+|-|\*|\/|\.|\()\s*$/u;
const MERGE_OPERATOR_REGEX = /[|&?]/;
const MERGE_OPERATOR_REGEX_GLOBAL = /[|&?]/g;
const SEMICOLON_SPLIT_REGEX = /;\s+/;

export function stripTrailingContinuationTokens(text: string): string {
  return text.replace(CONTINUATION_TOKEN_REGEX, "");
}

export function stripMergeOperatorChars(text: string): string {
  return text.replace(MERGE_OPERATOR_REGEX_GLOBAL, "");
}

interface PartMatch {
  index: number;
  matchedLen: number;
}

function getMergeExpansionParts(originalLines: string[]): string[] | null {
  const parts = originalLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return parts.length === originalLines.length ? parts : null;
}

function findExactOrTrimmedPart(
  merged: string,
  part: string,
  offset: number
): PartMatch | null {
  const exactIndex = merged.indexOf(part, offset);
  if (exactIndex !== -1) {
    return { index: exactIndex, matchedLen: part.length };
  }

  const stripped = stripTrailingContinuationTokens(part);
  if (stripped === part) {
    return null;
  }

  const strippedIndex = merged.indexOf(stripped, offset);
  if (strippedIndex === -1) {
    return null;
  }

  return { index: strippedIndex, matchedLen: stripped.length };
}

function advanceToStrippedIndex(
  segment: string,
  strippedIndex: number
): number {
  let strippedPos = 0;
  let originalPos = 0;

  while (strippedPos < strippedIndex && originalPos < segment.length) {
    if (!MERGE_OPERATOR_REGEX.test(segment[originalPos])) {
      strippedPos += 1;
    }
    originalPos += 1;
  }

  return originalPos;
}

function measureMatchedSegmentLength(
  segment: string,
  originalPos: number,
  strippedLength: number
): number {
  let consumed = 0;
  let realLen = 0;

  while (consumed < strippedLength && originalPos + realLen < segment.length) {
    if (!MERGE_OPERATOR_REGEX.test(segment[originalPos + realLen])) {
      consumed += 1;
    }
    realLen += 1;
  }

  return realLen;
}

function findFuzzyPartInMerged(
  merged: string,
  part: string,
  offset: number
): PartMatch | null {
  const segment = merged.slice(offset);
  const segmentStripped = stripMergeOperatorChars(segment);
  const partStripped = stripMergeOperatorChars(part);
  const fuzzyIdx = segmentStripped.indexOf(partStripped);

  if (fuzzyIdx === -1) {
    return null;
  }

  const originalPos = advanceToStrippedIndex(segment, fuzzyIdx);
  const matchedLen = measureMatchedSegmentLength(
    segment,
    originalPos,
    partStripped.length
  );

  return { index: offset + originalPos, matchedLen };
}

function findPartInMerged(
  merged: string,
  part: string,
  offset: number
): PartMatch | null {
  return (
    findExactOrTrimmedPart(merged, part, offset) ??
    findFuzzyPartInMerged(merged, part, offset)
  );
}

function collectOrderedMatchIndices(
  merged: string,
  parts: string[]
): number[] | null {
  const indices: number[] = [];
  let offset = 0;

  for (const part of parts) {
    const match = findPartInMerged(merged, part, offset);
    if (!match) {
      return null;
    }

    indices.push(match.index);
    offset = match.index + match.matchedLen;
  }

  return indices;
}

function expandFromIndices(merged: string, indices: number[]): string[] | null {
  const expanded: string[] = [];

  for (let i = 0; i < indices.length; i += 1) {
    const start = indices[i];
    const end = i + 1 < indices.length ? indices[i + 1] : merged.length;
    const candidate = merged.slice(start, end).trim();

    if (candidate.length === 0) {
      return null;
    }

    expanded.push(candidate);
  }

  return expanded;
}

function splitMergedBySemicolons(merged: string): string[] {
  return merged
    .split(SEMICOLON_SPLIT_REGEX)
    .map((line, idx, arr) => {
      if (idx < arr.length - 1 && !line.endsWith(";")) {
        return `${line};`;
      }
      return line;
    })
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function maybeExpandSingleLineMerge(
  originalLines: string[],
  replacementLines: string[]
): string[] {
  if (replacementLines.length !== 1 || originalLines.length <= 1) {
    return replacementLines;
  }

  const merged = replacementLines[0];
  const parts = getMergeExpansionParts(originalLines);
  if (!parts) {
    return replacementLines;
  }
  const indices = collectOrderedMatchIndices(merged, parts);
  const expanded = indices ? expandFromIndices(merged, indices) : null;

  if (expanded && expanded.length === originalLines.length) {
    return expanded;
  }

  const semicolonSplit = splitMergedBySemicolons(merged);

  if (semicolonSplit.length === originalLines.length) {
    return semicolonSplit;
  }

  return replacementLines;
}
