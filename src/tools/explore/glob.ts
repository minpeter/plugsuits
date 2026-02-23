import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { formatBlock, getIgnoreFilter } from "./safety-utils";

const MAX_RESULTS = 500;

interface FileWithMtime {
  mtime: Date;
  path: string;
}

const inputSchema = z.object({
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
});

export type GlobInput = z.input<typeof inputSchema>;

export async function executeGlob({
  pattern,
  path,
  respect_git_ignore = true,
}: GlobInput): Promise<string> {
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
        mtime: stats.mtime,
      });
    } catch {
      // Ignore files that cannot be accessed
    }
  }

  filesWithMtime.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const truncated = filesWithMtime.length > MAX_RESULTS;
  const displayFiles = truncated
    ? filesWithMtime.slice(0, MAX_RESULTS)
    : filesWithMtime;

  const output = [
    filesWithMtime.length > 0 ? "OK - glob" : "OK - glob (no matches)",
    `pattern: "${pattern}"`,
    `path: ${path ?? "."}`,
    `respect_git_ignore: ${respect_git_ignore}`,
    `file_count: ${filesWithMtime.length}`,
    `truncated: ${truncated}`,
    "sorted_by: mtime desc",
    "",
  ];

  if (displayFiles.length > 0) {
    const body = displayFiles
      .map((f) => {
        return f.path;
      })
      .join("\n");
    output.push(formatBlock("glob results", body));
  } else {
    output.push(formatBlock("glob results", "(no matches)"));
  }

  return output.join("\n");
}

export const globTool = tool({
  description:
    "Find files by pattern (e.g., '**/*.ts', 'src/**/*.json'). " +
    "Returns paths sorted by modification time (newest first).",
  inputSchema,
  execute: executeGlob,
});
