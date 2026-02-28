import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import {
  applyHashlineEditsWithReport,
  canonicalizeFileText,
  type HashlineEdit,
  normalizeHashlineEdits,
  restoreFileText,
} from "../utils/hashline";
import { assertWriteSafety, safeAtomicWriteFile } from "../utils/safety-utils";
import EDIT_FILE_DESCRIPTION from "./edit-file.txt";
import { buildEscalationBailMessage } from "./edit-file-diagnostics";
import type { HashlineToolEdit } from "./edit-file-repair";
import {
  assertExpectedFileHash,
  canCreateFromMissingFile,
  validateAndRepairEdits,
} from "./edit-file-validation";

const hashlineToolEditSchema = z
  .object({
    op: z
      .enum(["replace", "append", "prepend"])
      .describe("replace/append/prepend use hashline anchors."),
    pos: z
      .string()
      .optional()
      .describe(
        "Line anchor from read_file (format: {line_number}#{hash_id})."
      ),
    end: z
      .string()
      .optional()
      .describe(
        "Range end anchor for replace operations (format: {line_number}#{hash_id})."
      ),
    lines: z
      .union([z.array(z.string()), z.string(), z.null()])
      .describe(
        "Replacement content. string[] for new lines, string for single line, null or [] to delete."
      ),
  })
  .strict();

// Lenient schema: lines optional — fallback when model omits lines
// Custom validation in validateAndRepairEdits provides better error messages than ZodError
const lenientEditSchema = z
  .object({
    op: z.enum(["replace", "append", "prepend"]),
    pos: z.string().optional(),
    end: z.string().optional(),
    lines: z.union([z.array(z.string()), z.string(), z.null()]).optional(),
  })
  .strict();

const lenientInputSchema = z
  .object({
    path: z.string(),
    edits: z.array(lenientEditSchema).min(1),
    expected_file_hash: z.string().optional(),
  })
  .strict();

const inputSchema = z
  .object({
    path: z.string().describe("The path to the file"),
    edits: z
      .array(hashlineToolEditSchema)
      .min(1)
      .describe("Hashline-native edit operations."),
    expected_file_hash: z
      .string()
      .optional()
      .describe("Optional stale-check file hash from read_file output."),
  })
  .strict();

export type EditFileInput = z.input<typeof lenientInputSchema>;

export interface EditFileOptions {
  /** Override project root for safety checks (defaults to process.cwd()). */
  rootDir?: string;
}

// validateAndRepairEdits, canCreateFromMissingFile, assertExpectedFileHash
// moved to ./edit-file-validation.ts

function formatResult(params: {
  created: boolean;
  editCount: number;
  lineCountDelta: number;
  path: string;
  warningLines?: string[];
}): string {
  const action = params.created ? "Created" : "Updated";
  const output: string[] = [`${action} ${params.path}`];
  const summaryParts: string[] = [`${params.editCount} edit(s) applied`];
  if (params.lineCountDelta !== 0) {
    const sign = params.lineCountDelta > 0 ? "+" : "";
    summaryParts.push(`${sign}${params.lineCountDelta} line(s)`);
  }
  output.push(summaryParts.join(", "));
  if (params.warningLines && params.warningLines.length > 0) {
    output.push("");
    output.push("Warnings:");
    output.push(...params.warningLines);
  }
  return output.join("\n");
}

async function ensureParentDir(path: string): Promise<void> {
  const directory = dirname(path);
  if (directory !== ".") {
    await mkdir(directory, { recursive: true });
  }
}

async function readExistingContent(path: string): Promise<{
  content: string;
  exists: boolean;
}> {
  try {
    return {
      content: await readFile(path, "utf-8"),
      exists: true,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {
        content: "",
        exists: false,
      };
    }
    throw error;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: complex validation logic
export async function executeEditFile(input: EditFileInput, options?: EditFileOptions): Promise<string> {
  let parsed: z.infer<typeof inputSchema>;
  try {
    parsed = inputSchema.parse(input);
  } catch (error) {
    if (
      error instanceof z.ZodError &&
      error.issues.some(
        (issue) => issue.path.length >= 2 && issue.path.at(-1) === "lines"
      )
    ) {
      // Fall back to lenient parse — custom validation gives better error messages
      parsed = lenientInputSchema.parse(input) as z.infer<typeof inputSchema>;
    } else {
      throw error;
    }
  }

  // C-1 + C-2: Path traversal and symlink safety checks
  const safePath = await assertWriteSafety(parsed.path, options?.rootDir);

  const { content: rawContent, exists } = await readExistingContent(
    safePath
  );
  const oldEnvelope = canonicalizeFileText(rawContent);
  const fileLines = exists ? oldEnvelope.content.split("\n") : [];

  let repairWarnings: string[];
  let normalizedEdits: HashlineEdit[];
  try {
    const validateResult = validateAndRepairEdits(
      parsed.edits as HashlineToolEdit[],
      fileLines,
      parsed.path
    );
    repairWarnings = validateResult.repairWarnings;
    normalizedEdits = normalizeHashlineEdits(validateResult.edits);
  } catch (parseError) {
    if (
      parseError instanceof Error &&
      parseError.message.includes("explicit 'lines'")
    ) {
      const bailMessage = buildEscalationBailMessage(
        parsed.edits,
        parsed.path,
        fileLines
      );
      if (bailMessage) {
        return bailMessage;
      }
    }
    throw parseError;
  }

  if (!(exists || canCreateFromMissingFile(normalizedEdits))) {
    throw new Error(`File not found: ${parsed.path}`);
  }

  assertExpectedFileHash(parsed.expected_file_hash, rawContent);

  const applyResult = applyHashlineEditsWithReport(
    oldEnvelope.content,
    normalizedEdits
  );
  const canonicalNewContent = applyResult.content;

  if (canonicalNewContent === oldEnvelope.content) {
    let diagnostic = `No changes made to ${parsed.path}. The edits produced identical content.`;
    if (applyResult.noopEdits > 0) {
      diagnostic += ` No-op edits: ${applyResult.noopEdits}. Re-read the file and provide content that differs from current lines.`;
    }
    return `Error: ${diagnostic}`;
  }

  const writeContent = restoreFileText(canonicalNewContent, oldEnvelope);

  await ensureParentDir(safePath);
  await safeAtomicWriteFile(safePath, writeContent);

  const originalLineCount = rawContent.split("\n").length;
  const newLineCount = writeContent.split("\n").length;

  const allWarnings: string[] = [...repairWarnings];
  if (applyResult.noopEdits > 0) {
    allWarnings.push(
      `${applyResult.noopEdits} edit(s) were no-ops because replacement text matched existing content.`
    );
  }
  if (applyResult.deduplicatedEdits > 0) {
    allWarnings.push(
      `${applyResult.deduplicatedEdits} duplicate edit(s) were removed.`
    );
  }

  return formatResult({
    created: !exists,
    editCount: parsed.edits.length,
    lineCountDelta: newLineCount - originalLineCount,
    path: parsed.path,
    warningLines: allWarnings.length > 0 ? allWarnings : undefined,
  });
}

export const editFileTool = tool({
  description: EDIT_FILE_DESCRIPTION,
  inputSchema,
  execute: (input) => executeEditFile(input),
});
