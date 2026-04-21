import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tool } from "ai";
import { globIterate } from "glob";
import { z } from "zod";
import { readTextAsset } from "../../utils/text-asset";
import { formatBlock, getIgnoreFilter } from "../utils/safety-utils";

const GLOB_FILES_DESCRIPTION = readTextAsset(
  "./glob-files.txt",
  import.meta.url
);

const MAX_RESULTS = 500;
const MAX_GLOB_RESULTS = 10_000; // max candidates scanned before stat phase
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

  // Canonicalize searchDir by resolving all symlinks for containment checks.
  let canonicalSearchDir: string;
  try {
    canonicalSearchDir = await realpath(searchDir);
  } catch {
    canonicalSearchDir = searchDir;
  }

  const topFilesByMtime: FileWithMtime[] = [];
  let totalMatches = 0;
  let skippedUnreadable = 0;
  let candidateCount = 0;
  let globLimitReached = false;

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

  for await (const file of globIterate(pattern, {
    absolute: false,
    cwd: searchDir,
    nodir: true,
  })) {
    if (ignoreFilter?.ignores(file)) {
      continue;
    }

    // Enforce candidate limit before stat phase.
    candidateCount += 1;
    if (candidateCount > MAX_GLOB_RESULTS) {
      globLimitReached = true;
      break;
    }

    const absolutePath = join(searchDir, file);

    // Symlink containment: resolve symlinks and verify the real path
    // stays within searchDir to prevent traversal via symlinks.
    let realAbsolutePath: string;
    try {
      realAbsolutePath = await realpath(absolutePath);
    } catch {
      // Broken symlink or inaccessible path — skip silently.
      continue;
    }

    if (
      realAbsolutePath !== canonicalSearchDir &&
      !realAbsolutePath.startsWith(canonicalSearchDir + sep)
    ) {
      // File resolves outside searchDir via symlink — skip silently.
      continue;
    }

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
    `glob_limit_reached: ${globLimitReached}`,
    "sorted_by: mtime desc",
    "",
  ];

  if (displayFiles.length > 0) {
    const body = displayFiles.map((f) => f.path).join("\n");
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
