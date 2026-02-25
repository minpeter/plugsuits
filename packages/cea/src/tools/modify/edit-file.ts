import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import {
  applyHashlineEdits,
  computeFileHash,
  type HashlineEdit,
  parseHashlineText,
  parseLineTag,
} from "../utils/hashline/hashline";
import EDIT_FILE_DESCRIPTION from "./edit-file.txt";

type HashlineToolOp = "append" | "prepend" | "replace";
type LineEnding = "\n" | "\r\n";

interface HashlineToolEdit {
  end?: string;
  lines?: string[] | string | null;
  op: HashlineToolOp;
  pos?: string;
}

const hashlineToolEditSchema = z
  .object({
    op: z
      .enum(["replace", "append", "prepend"])
      .describe("replace/append/prepend use hashline anchors."),
    pos: z
      .string()
      .optional()
      .describe("Line anchor from read_file (format: LINE#HASH)."),
    end: z
      .string()
      .optional()
      .describe("Range end anchor for replace operations (format: LINE#HASH)."),
    lines: z
      .union([z.array(z.string()), z.string(), z.null()])
      .optional()
      .describe("Replacement/inserted lines. null or [] deletes for replace."),
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

export type EditFileInput = z.input<typeof inputSchema>;

function parseReplaceEdit(edit: HashlineToolEdit): HashlineEdit {
  const primaryRef = edit.pos ?? edit.end;
  if (!primaryRef) {
    throw new Error("replace requires pos or end anchor.");
  }

  return {
    op: "replace",
    pos: parseLineTag(primaryRef),
    end: edit.end ? parseLineTag(edit.end) : undefined,
    lines: parseHashlineText(edit.lines),
  };
}

function parseAppendPrependEdit(
  op: "append" | "prepend",
  edit: HashlineToolEdit
): HashlineEdit {
  const ref = op === "append" ? (edit.pos ?? edit.end) : (edit.end ?? edit.pos);
  return {
    op,
    pos: ref ? parseLineTag(ref) : undefined,
    lines: parseHashlineText(edit.lines),
  };
}

function parseHashlineToolEdits(edits: HashlineToolEdit[]): HashlineEdit[] {
  return edits.map((edit) => {
    switch (edit.op) {
      case "replace":
        return parseReplaceEdit(edit);
      case "append":
        return parseAppendPrependEdit("append", edit);
      case "prepend":
        return parseAppendPrependEdit("prepend", edit);
      default:
        throw new Error("Unsupported edit operation.");
    }
  });
}

function canCreateMissingFileWithHashlineEdits(edits: HashlineEdit[]): boolean {
  return edits.every((edit) => edit.op !== "replace" && edit.pos === undefined);
}

function resolvePreferredLineEnding(content: string): LineEnding {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function applyPreferredLineEnding(
  content: string,
  lineEnding: LineEnding
): string {
  if (lineEnding === "\n") {
    return content.replace(/\r\n/g, "\n");
  }
  return content.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

function assertExpectedFileHash(
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

function formatHashlineModeResult(params: {
  created: boolean;
  path: string;
  warningLines?: string[];
}): string {
  const action = params.created ? "Created" : "Updated";
  const output: string[] = [`${action} ${params.path}`];

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

export async function executeEditFile(input: EditFileInput): Promise<string> {
  const parsed = inputSchema.parse(input);
  const hashlineEdits = parseHashlineToolEdits(parsed.edits);

  const { content: loadedContent, exists } = await readExistingContent(
    parsed.path
  );
  let content = loadedContent;

  if (!exists) {
    if (!canCreateMissingFileWithHashlineEdits(hashlineEdits)) {
      throw new Error(`File not found: ${parsed.path}`);
    }
    content = "";
  }

  assertExpectedFileHash(parsed.expected_file_hash, content);

  const preferredLineEnding = resolvePreferredLineEnding(content);
  const hashlineResult = applyHashlineEdits(content, hashlineEdits);
  const normalizedContent = applyPreferredLineEnding(
    hashlineResult.lines,
    preferredLineEnding
  );

  if (normalizedContent === content) {
    throw new Error(
      "No changes made. The provided hashline edits resolved to identical content."
    );
  }

  await ensureParentDir(parsed.path);
  await writeFile(parsed.path, normalizedContent, "utf-8");

  return formatHashlineModeResult({
    created: !exists,
    path: parsed.path,
    warningLines: hashlineResult.warnings,
  });
}

export const editFileTool = tool({
  description: EDIT_FILE_DESCRIPTION,
  inputSchema,
  execute: executeEditFile,
});
