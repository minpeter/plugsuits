export function stripTrailingContinuationTokens(text: string): string {
  return text.replace(/(?:&&|\|\||\?\?|\?|:|=|,|\+|-|\*|\/|\.|\()\s*$/u, "");
}

export function stripMergeOperatorChars(text: string): string {
  return text.replace(/[|&?]/g, "");
}

export function maybeExpandSingleLineMerge(
  originalLines: string[],
  replacementLines: string[]
): string[] {
  if (replacementLines.length !== 1 || originalLines.length <= 1) {
    return replacementLines;
  }

  const merged = replacementLines[0];
  const parts = originalLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (parts.length !== originalLines.length) {
    return replacementLines;
  }

  const indices: number[] = [];
  let offset = 0;
  let orderedMatch = true;
  for (const part of parts) {
    let idx = merged.indexOf(part, offset);
    let matchedLen = part.length;
    if (idx === -1) {
      const stripped = stripTrailingContinuationTokens(part);
      if (stripped !== part) {
        idx = merged.indexOf(stripped, offset);
        if (idx !== -1) {
          matchedLen = stripped.length;
        }
      }
    }
    if (idx === -1) {
      const segment = merged.slice(offset);
      const segmentStripped = stripMergeOperatorChars(segment);
      const partStripped = stripMergeOperatorChars(part);
      const fuzzyIdx = segmentStripped.indexOf(partStripped);
      if (fuzzyIdx !== -1) {
        let strippedPos = 0;
        let originalPos = 0;
        while (strippedPos < fuzzyIdx && originalPos < segment.length) {
          if (!/[|&?]/.test(segment[originalPos])) {
            strippedPos += 1;
          }
          originalPos += 1;
        }
        idx = offset + originalPos;
        // Compute actual consumed length in original string by walking through
        // until partStripped.length non-operator characters are consumed
        let consumed = 0;
        let realLen = 0;
        while (consumed < partStripped.length && (originalPos + realLen) < segment.length) {
          if (!/[|&?]/.test(segment[originalPos + realLen])) {
            consumed += 1;
          }
          realLen += 1;
        }
        matchedLen = realLen;
      }
    }
    if (idx === -1) {
      orderedMatch = false;
      break;
    }
    indices.push(idx);
    offset = idx + matchedLen;
  }

  const expanded: string[] = [];
  if (orderedMatch) {
    for (let i = 0; i < indices.length; i += 1) {
      const start = indices[i];
      const end = i + 1 < indices.length ? indices[i + 1] : merged.length;
      const candidate = merged.slice(start, end).trim();
      if (candidate.length === 0) {
        orderedMatch = false;
        break;
      }
      expanded.push(candidate);
    }
  }

  if (orderedMatch && expanded.length === originalLines.length) {
    return expanded;
  }

  const semicolonSplit = merged
    .split(/;\s+/)
    .map((line, idx, arr) => {
      if (idx < arr.length - 1 && !line.endsWith(";")) {
        return `${line};`;
      }
      return line;
    })
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (semicolonSplit.length === originalLines.length) {
    return semicolonSplit;
  }

  return replacementLines;
}
