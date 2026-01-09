import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { getIgnoreFilter } from "./safety-utils";

interface FileWithMtime {
  path: string;
  mtime: number;
}

export const globTool = tool({
  description:
    "Find files by pattern (e.g., '**/*.ts', 'src/**/*.json'). " +
    "Returns absolute paths sorted by modification time (newest first).",
  inputSchema: z.object({
    pattern: z.string().describe("Glob pattern (e.g., '**/*.py', 'docs/*.md')"),
    path: z
      .string()
      .optional()
      .describe("Directory to search (default: current directory)"),
    respect_git_ignore: z
      .boolean()
      .optional()
      .default(true)
      .describe("Respect .gitignore (default: true)"),
  }),
  execute: async ({ pattern, path, respect_git_ignore }) => {
    const searchDir = path ? resolve(path) : process.cwd();

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
