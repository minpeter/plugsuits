import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";

const inputSchema = z.object({
  path: z.string().describe("The path to the file"),
  old_str: z
    .string()
    .describe(
      "Text to search for - must match exactly. " +
        "By default, must have exactly one match unless replace_all is true."
    ),
  new_str: z.string().describe("Text to replace old_str with"),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, replace all occurrences of old_str. " +
        "If false (default), old_str must match exactly once."
    ),
});

export const editFileTool = tool({
  description:
    "Replace text in file (surgical edits). " +
    "old_str must match exactly. " +
    "Use replace_all: true for multiple replacements. " +
    "Creates file if it doesn't exist (when old_str is empty).",
  needsApproval: true,
  inputSchema,
  execute: async ({
    path,
    old_str,
    new_str,
    replace_all,
  }: z.infer<typeof inputSchema>) => {
    if (!path || old_str === new_str) {
      throw new Error("Invalid input parameters");
    }

    let content: string;

    try {
      content = await readFile(path, "utf-8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        old_str === ""
      ) {
        const dir = dirname(path);
        if (dir !== ".") {
          await mkdir(dir, { recursive: true });
        }
        await writeFile(path, new_str, "utf-8");
        return `Successfully created file ${path}`;
      }
      throw error;
    }

    if (old_str !== "" && !content.includes(old_str)) {
      throw new Error("old_str not found in file");
    }

    let newContent: string;
    let replacementCount = 0;

    if (replace_all) {
      const parts = content.split(old_str);
      replacementCount = parts.length - 1;
      newContent = parts.join(new_str);
    } else {
      const matchCount = content.split(old_str).length - 1;
      if (matchCount > 1) {
        throw new Error(
          `old_str found ${matchCount} times in file. ` +
            "Use replace_all: true to replace all occurrences, " +
            "or provide more context to match exactly once."
        );
      }
      newContent = content.replace(old_str, new_str);
      replacementCount = 1;
    }

    if (content === newContent && old_str !== "") {
      throw new Error("old_str not found in file");
    }

    await writeFile(path, newContent, "utf-8");
    return replace_all
      ? `OK - replaced ${replacementCount} occurrence(s)`
      : "OK";
  },
});
