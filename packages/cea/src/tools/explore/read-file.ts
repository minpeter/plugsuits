import { basename } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { readTextAsset } from "../../utils/text-asset";
import { formatBlock, safeReadFileEnhanced } from "../utils/safety-utils";
import { truncateToolOutput } from "../utils/tool-output-truncation";
import { recordReadOnlyToolCall } from "./read-only-call-guard";

const READ_FILE_DESCRIPTION = readTextAsset("./read-file.txt", import.meta.url);

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
  respect_git_ignore: z
    .boolean()
    .optional()
    .default(true)
    .describe("Respect ignore rules from .gitignore/.ignore/.fdignore"),
});

export type ReadFileInput = z.input<typeof inputSchema>;

export async function executeReadFile({
  path,
  offset,
  limit,
  around_line,
  before,
  after,
  respect_git_ignore,
}: ReadFileInput): Promise<string> {
  const parsedInput = inputSchema.parse({
    path,
    offset,
    limit,
    around_line,
    before,
    after,
    respect_git_ignore,
  });

  const guard = recordReadOnlyToolCall("read_file", parsedInput);
  if (guard.suppress) {
    return [
      "OK - read file (duplicate request suppressed)",
      `path: ${parsedInput.path}`,
      `repeat_count: ${guard.repeatCount}`,
      "The exact same file slice was already read recently.",
      "Use the existing context or request a different path/range/around_line if you need new information.",
    ].join("\n");
  }

  const result = await safeReadFileEnhanced(path, {
    offset: parsedInput.offset,
    limit: parsedInput.limit,
    around_line: parsedInput.around_line,
    before: parsedInput.before,
    after: parsedInput.after,
    respect_git_ignore: parsedInput.respect_git_ignore,
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
    `respect_git_ignore: ${parsedInput.respect_git_ignore}`,
    "",
    formatBlock(`${fileName} ${rangeStr}`, result.numberedContent),
  ];

  return (await truncateToolOutput("read_file", output.join("\n"))).text;
}

export const readFileTool = tool({
  description: READ_FILE_DESCRIPTION,
  inputSchema,
  execute: executeReadFile,
});
