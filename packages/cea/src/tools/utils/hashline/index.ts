// === Source-matching re-exports (1:1 from oh-my-opencode) ===

// biome-ignore lint/performance/noBarrelFile: intentional barrel file for hashline module public API
export {
  HASHLINE_DICT,
  HASHLINE_OUTPUT_PATTERN,
  HASHLINE_REF_PATTERN,
  NIBBLE_STR,
} from "./constants";
export type { HashlineApplyReport } from "./edit-operations";
export {
  applyHashlineEdits,
  applyHashlineEditsWithReport,
} from "./edit-operations";
export {
  parseHashlineText,
  stripLinePrefixes,
  toNewLines,
} from "./edit-text-normalization";
export type { FileTextEnvelope } from "./file-text-canonicalization";
export {
  canonicalizeFileText,
  restoreFileText,
} from "./file-text-canonicalization";
export type { HashlineStreamOptions } from "./hash-computation";
export {
  computeFileHash,
  computeLineHash,
  formatHashLine,
  formatHashLines,
  formatHashlineNumberedLines,
  formatLineTag,
  streamHashLinesFromLines,
  streamHashLinesFromLines as streamHashlineNumberedLinesFromLines,
  streamHashLinesFromUtf8,
  streamHashLinesFromUtf8 as streamHashlineNumberedLinesFromUtf8,
} from "./hash-computation";
export type { RawHashlineEdit } from "./normalize-edits";
export { normalizeHashlineEdits } from "./normalize-edits";
export type {
  AppendEdit,
  HashlineEdit,
  PrependEdit,
  ReplaceEdit,
} from "./types";
export type { LineRef, LineRef as LineTag } from "./validation";
// parseLineRef wrappers with old names
export {
  HashlineMismatchError,
  parseLineRef,
  parseLineRef as parseLineTag,
  tryParseLineTag,
  validateLineRef,
  validateLineRefs,
} from "./validation";
