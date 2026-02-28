import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { assertWriteSafety, safeAtomicWriteFile } from "../utils/safety-utils";
import WRITE_FILE_DESCRIPTION from "./write-file.txt";

const inputSchema = z.object({
  path: z.string().describe("File path (absolute or relative)"),
  content: z.string().describe("Content to write"),
});

export type WriteFileInput = z.infer<typeof inputSchema>;

export interface WriteFileOptions {
  /** Override project root for safety checks (defaults to process.cwd()). */
  rootDir?: string;
}

export async function executeWriteFile(
  { path, content }: WriteFileInput,
  options?: WriteFileOptions
): Promise<string> {
  // C-1 + C-2: Path traversal and symlink safety checks
  const safePath = await assertWriteSafety(path, options?.rootDir);

  const dir = dirname(safePath);
  if (dir !== ".") {
    await mkdir(dir, { recursive: true });
  }

  // H-1: Atomic write with O_EXCL temp file + rename.
  // safeAtomicWriteFile handles existence check (lstat), symlink rejection,
  // crypto-random temp names, O_EXCL to prevent pre-creation attacks,
  // and POSIX rename() which does not follow symlinks.
  const { existed } = await safeAtomicWriteFile(safePath, content);

  const lines = content.split("\n");
  const lineCount = lines.length;
  const byteCount = Buffer.byteLength(content, "utf-8");
  const fileName = basename(path);
  const action = existed ? "overwrote" : "created";

  const output = [
    `OK - ${action} ${fileName}`,
    `bytes: ${byteCount}, lines: ${lineCount}`,
  ];

  return output.join("\n");
}

export const writeFileTool = tool({
  description: WRITE_FILE_DESCRIPTION,
  inputSchema,
  execute: (input) => executeWriteFile(input),
});
