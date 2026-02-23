import { basename } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import READ_FILE_DESCRIPTION from "./read-file.txt";
import { formatBlock, safeReadFileEnhanced } from "./safety-utils";

const inputSchema = z.object({
  path: z.string().describe("File path (absolute or relative)"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Start line (0-based, default: 0). Use around_line for smarter reading."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Max lines to read (default: 2000)"),
  around_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Read around this line (1-based). Combines with before/after."),
  before: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Lines before around_line (default: 5)"),
  after: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Lines after around_line (default: 10)"),
});

export type ReadFileInput = z.input<typeof inputSchema>;

export async function executeReadFile({
  path,
  offset,
  limit,
  around_line,
  before,
  after,
}: ReadFileInput): Promise<string> {
  const parsedInput = inputSchema.parse({
    path,
    offset,
    limit,
    around_line,
    before,
    after,
  });

  const result = await safeReadFileEnhanced(path, {
    offset: parsedInput.offset,
    limit: parsedInput.limit,
    around_line: parsedInput.around_line,
    before: parsedInput.before,
    after: parsedInput.after,
  });

  const fileName = basename(path);
  const rangeStr = `L${result.startLine1}-L${result.endLine1}`;

  const output = [
    "OK - read file",
    `path: ${path}`,
    `bytes: ${result.bytes}`,
    `last_modified: ${result.lastModified}`,
    `lines: ${result.totalLines} (returned: ${result.endLine1 - result.startLine1 + 1})`,
    `file_hash: ${result.fileHash}`,
    `range: ${rangeStr}`,
    `truncated: ${result.truncated}`,
    "",
    formatBlock(`${fileName} ${rangeStr}`, result.numberedContent),
  ];

  return output.join("\n");
}

export const readFileTool = tool({
  description: READ_FILE_DESCRIPTION,
  inputSchema,
  execute: executeReadFile,
});
