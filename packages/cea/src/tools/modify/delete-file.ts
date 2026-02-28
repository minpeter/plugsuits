import { lstat, rm } from "node:fs/promises";
import { basename } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { assertWriteSafety } from "../utils/safety-utils";
import DELETE_FILE_DESCRIPTION from "./delete-file.txt";

const inputSchema = z.object({
  path: z.string().describe("Path to delete"),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Delete directories recursively (default: false)"),
  ignore_missing: z
    .boolean()
    .optional()
    .default(false)
    .describe("Don't error if file doesn't exist (default: false)"),
});

export type DeleteFileInput = z.input<typeof inputSchema>;

export interface DeleteFileOptions {
  /** Override project root for safety checks (defaults to process.cwd()). */
  rootDir?: string;
}

export async function executeDeleteFile(
  { path, recursive = false, ignore_missing = false }: DeleteFileInput,
  options?: DeleteFileOptions
): Promise<string> {
  // C-1 + C-2: Path traversal and symlink safety checks
  const safePath = await assertWriteSafety(path, options?.rootDir);

  // C-2: Use lstat (not stat) — lstat does NOT follow symlinks,
  // so we see the symlink entry itself rather than its target.
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(safePath);
  } catch (error) {
    if (
      ignore_missing &&
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return `SKIPPED - file does not exist: ${path}`;
    }
    throw error;
  }

  // Reject symlink deletion — force explicit resolution
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Refusing to delete symlink: '${path}'. ` +
        "Resolve the symlink first or operate on the real file directly."
    );
  }

  const isDirectory = stats.isDirectory();
  const fileName = basename(path);
  const byteSize = isDirectory ? null : stats.size;
  const mtime = stats.mtime.toISOString();

  if (isDirectory && !recursive) {
    throw new Error(
      `Cannot delete directory '${path}' without recursive: true. ` +
        "Set recursive: true to delete directories."
    );
  }

  await rm(safePath, { recursive, force: false });

  const output: string[] = [];

  if (isDirectory) {
    output.push(`OK - deleted directory: ${fileName}`);
    output.push(`path: ${path}`);
    output.push(`last_modified: ${mtime}`);
  } else {
    output.push(`OK - deleted file: ${fileName}`);
    output.push(`path: ${path}`);
    output.push(`bytes: ${byteSize}`);
    output.push(`last_modified: ${mtime}`);
  }

  return output.join("\n");
}

export const deleteFileTool = tool({
  description: DELETE_FILE_DESCRIPTION,
  inputSchema,
  execute: (input) => executeDeleteFile(input),
});
