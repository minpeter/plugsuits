import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { getIgnoreFilter } from "../file/file-safety";

interface FileWithMtime {
  path: string;
  mtime: number;
}

export const globTool = tool({
  description:
    "Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), " +
    "returning absolute paths sorted by modification time (newest first). " +
    "Ideal for quickly locating files based on their name or path structure.",
  inputSchema: z.object({
    pattern: z
      .string()
      .describe(
        "The glob pattern to match against (e.g., '**/*.py', 'docs/*.md')."
      ),
    dir_path: z
      .string()
      .optional()
      .describe(
        "Optional: The absolute path to the directory to search within. " +
          "If omitted, searches the current working directory."
      ),
    respect_git_ignore: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Optional: Whether to respect .gitignore patterns when finding files. Defaults to true."
      ),
  }),
  execute: async ({ pattern, dir_path, respect_git_ignore }) => {
    const searchDir = dir_path ? resolve(dir_path) : process.cwd();

    const glob = new Bun.Glob(pattern);
    const filesWithMtime: FileWithMtime[] = [];

    const ignoreFilter = respect_git_ignore ? await getIgnoreFilter() : null;

    for await (const file of glob.scan({
      cwd: searchDir,
      absolute: false,
      onlyFiles: true,
    })) {
      if (ignoreFilter?.ignores(file)) {
        continue;
      }

      const absolutePath = join(searchDir, file);
      try {
        const stats = await stat(absolutePath);
        filesWithMtime.push({
          path: absolutePath,
          mtime: stats.mtimeMs,
        });
      } catch {
        // File might have been deleted between scan and stat, skip it
      }
    }

    // Sort by modification time (newest first)
    filesWithMtime.sort((a, b) => b.mtime - a.mtime);

    // Return only the paths
    const result = filesWithMtime.map((f) => f.path);

    return JSON.stringify(result);
  },
});
