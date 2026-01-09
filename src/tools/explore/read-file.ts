import { tool } from "ai";
import { z } from "zod";
import { safeReadFile } from "./safety-utils";

export const readFileTool = tool({
  description:
    "Read file contents with line numbers. " +
    "ALWAYS read before editing. " +
    "Supports pagination for large files (offset/limit).",
  inputSchema: z.object({
    path: z.string().describe("File path (absolute or relative)"),
    offset: z
      .number()
      .optional()
      .describe("Start line number (0-based, default: 0)"),
    limit: z.number().optional().describe("Max lines to read (default: 2000)"),
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
