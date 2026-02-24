import { rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { tool } from "ai";
import { z } from "zod";
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

export async function executeDeleteFile({
  path,
  recursive = false,
  ignore_missing = false,
}: DeleteFileInput): Promise<string> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(path);
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

  await rm(path, { recursive, force: false });

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
  execute: executeDeleteFile,
});
