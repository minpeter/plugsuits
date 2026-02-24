import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { formatBlock, getIgnoreFilter } from "../utils/safety-utils";
import GLOB_FILES_DESCRIPTION from "./glob-files.txt";

const MAX_RESULTS = 500;
const STAT_CONCURRENCY = 32;

interface FileWithMtime {
  mtime: Date;
  path: string;
}

function insertTopByMtime(list: FileWithMtime[], item: FileWithMtime): void {
  let insertAt = list.length;
  for (let i = 0; i < list.length; i++) {
    if (item.mtime.getTime() > list[i].mtime.getTime()) {
      insertAt = i;
      break;
    }
  }

  list.splice(insertAt, 0, item);
  if (list.length > MAX_RESULTS) {
    list.pop();
  }
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
    .describe(
      "Respect ignore rules from .gitignore/.ignore/.fdignore (default: true)"
    ),
});

export type GlobInput = z.input<typeof inputSchema>;

export async function executeGlob({
  pattern,
  path,
  respect_git_ignore = true,
}: GlobInput): Promise<string> {
  const searchDir = path ? resolve(path) : process.cwd();

  const glob = new Bun.Glob(pattern);
  const topFilesByMtime: FileWithMtime[] = [];
  let totalMatches = 0;
  let skippedUnreadable = 0;

  const ignoreFilter = respect_git_ignore
    ? await getIgnoreFilter(searchDir)
    : null;

  const pending = new Set<Promise<void>>();

  const enqueueStat = (absolutePath: string): void => {
    const task = stat(absolutePath)
      .then((stats) => {
        totalMatches += 1;
        insertTopByMtime(topFilesByMtime, {
          path: absolutePath,
          mtime: stats.mtime,
        });
      })
      .catch(() => {
        skippedUnreadable += 1;
      })
      .finally(() => {
        pending.delete(task);
      });

    pending.add(task);
  };

  for await (const file of glob.scan({
    cwd: searchDir,
    absolute: false,
    onlyFiles: true,
  })) {
    if (ignoreFilter?.ignores(file)) {
      continue;
    }

    const absolutePath = join(searchDir, file);
    enqueueStat(absolutePath);

    if (pending.size >= STAT_CONCURRENCY) {
      await Promise.race(pending);
    }
  }

  await Promise.all(pending);

  const truncated = totalMatches > MAX_RESULTS;
  const displayFiles = topFilesByMtime;

  const output = [
    totalMatches > 0 ? "OK - glob" : "OK - glob (no matches)",
    `pattern: "${pattern}"`,
    `path: ${path ?? "."}`,
    `respect_git_ignore: ${respect_git_ignore}`,
    `file_count: ${totalMatches}`,
    `truncated: ${truncated}`,
    `skipped_unreadable: ${skippedUnreadable}`,
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
  description: GLOB_FILES_DESCRIPTION,
  inputSchema,
  execute: executeGlob,
});
