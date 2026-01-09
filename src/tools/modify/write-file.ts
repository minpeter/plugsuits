import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";

export const writeFileTool = tool({
  description:
    "Create new file or completely overwrite existing file. " +
    "Creates parent directories automatically. " +
    "Use edit_file for surgical changes to existing files.",
  needsApproval: true,
  inputSchema: z.object({
    path: z.string().describe("File path (absolute or relative)"),
    content: z.string().describe("Content to write"),
  }),
  execute: async ({ path, content }) => {
    const dir = dirname(path);
    if (dir !== ".") {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(path, content, "utf-8");
    return `Successfully wrote ${content.length} characters to ${path}`;
  },
});
