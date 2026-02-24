import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import WRITE_FILE_DESCRIPTION from "./write-file.txt";

const inputSchema = z.object({
  path: z.string().describe("File path (absolute or relative)"),
  content: z.string().describe("Content to write"),
});

export type WriteFileInput = z.infer<typeof inputSchema>;

export async function executeWriteFile({
  path,
  content,
}: WriteFileInput): Promise<string> {
  const dir = dirname(path);
  if (dir !== ".") {
    await mkdir(dir, { recursive: true });
  }

  let existed = false;
  try {
    await stat(path);
    existed = true;
  } catch {
    existed = false;
  }

  await writeFile(path, content, "utf-8");

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
  execute: executeWriteFile,
});
