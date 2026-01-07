import { tool } from "ai";
import { z } from "zod";
import { safeReadFile } from "./file-safety";

export const readFileTool = tool({
  description:
    "Read the contents of a given relative file path. " +
    "Use this when you want to see what's inside a file. " +
    "Do not use this with directory names. " +
    "Files in .gitignore, binary files, and files over 1MB will be rejected. " +
    "Supports pagination with offset and limit for large files.",
  inputSchema: z.object({
    path: z
      .string()
      .describe("The relative path of a file in the working directory."),
    offset: z
      .number()
      .optional()
      .describe(
        "The 0-based line number to start reading from. Defaults to 0."
      ),
    limit: z
      .number()
      .optional()
      .describe(
        "Maximum number of lines to read. Defaults to 2000. " +
          "Use with offset to paginate through large files."
      ),
  }),
  execute: async ({ path, offset, limit }) => {
    const result = await safeReadFile(path, { offset, limit });

    let output = result.content;
    if (result.truncated || result.startLine > 0) {
      output += `

[Lines ${result.startLine + 1}-${result.endLine} of ${result.totalLines} total]`;
    }

    return output;
  },
});
