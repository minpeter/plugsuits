import { rm, stat } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";

export const deleteFileTool = tool({
  description:
    "Delete file or directory (CANNOT BE UNDONE). " +
    "Use recursive: true for non-empty directories.",
  needsApproval: true,
  inputSchema: z.object({
    path: z.string().describe("Path to delete"),
    recursive: z
      .boolean()
      .optional()
      .default(false)
      .describe("Delete directories recursively (default: false)"),
  }),
  execute: async ({ path, recursive }) => {
    const stats = await stat(path);
    const isDirectory = stats.isDirectory();

    if (isDirectory && !recursive) {
      throw new Error(
        `Cannot delete directory '${path}' without recursive: true. ` +
          "Set recursive: true to delete directories."
      );
    }

    await rm(path, { recursive, force: false });

    return isDirectory
      ? `Successfully deleted directory: ${path}`
      : `Successfully deleted file: ${path}`;
  },
});
