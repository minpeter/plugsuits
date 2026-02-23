import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { ensureTool } from "../../utils/tools-manager";
import { formatLineTag } from "../utils/hashline/hashline";
import GREP_FILES_DESCRIPTION from "./grep-files.txt";
import { formatBlock } from "./safety-utils";

const MAX_MATCHES = 20_000;

interface GrepResult {
  matchCount: number;
  matches: string;
  truncated: boolean;
}

const RG_RESULT_LINE_PATTERN = /^(.*?)[:-](\d+)[:-](.*)$/;

function formatHashlineCompatibleMatches(rawMatches: string): string {
  if (!rawMatches) {
    return rawMatches;
  }

  return rawMatches
    .split("\n")
    .map((line) => {
      if (line.length === 0 || line === "--") {
        return line;
      }

      const matched = line.match(RG_RESULT_LINE_PATTERN);
      if (!matched) {
        return line;
      }

      const [, filePath, lineNumberText, content] = matched;
      const lineNumber = Number.parseInt(lineNumberText, 10);
      if (!Number.isFinite(lineNumber) || lineNumber < 1) {
        return line;
      }

      const tag = formatLineTag(lineNumber, content);
      return `${filePath}:${tag} | ${content}`;
    })
    .join("\n");
}

async function runRipgrep(args: string[], cwd: string): Promise<GrepResult> {
  const rgPath = await ensureTool("rg");
  if (!rgPath) {
    throw new Error(
      "ripgrep (rg) is not available. Please install it or check your PATH."
    );
  }

  return new Promise((resolvePromise, reject) => {
    const rg = spawn(rgPath, args, { cwd });

    let stdout = "";
    let stderr = "";

    rg.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    rg.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    rg.on("close", (code) => {
      if (code === 0 || code === 1) {
        const lines = stdout.split("\n").filter((line) => line.length > 0);
        const truncated = lines.length > MAX_MATCHES;
        const result = truncated
          ? lines.slice(0, MAX_MATCHES).join("\n")
          : stdout.trim();

        resolvePromise({
          matches: result,
          matchCount: Math.min(lines.length, MAX_MATCHES),
          truncated,
        });
      } else {
        const errorDetail =
          stderr ||
          "Check that regex pattern is valid and you have read permissions.";
        reject(new Error(`Search failed (exit code ${code}): ${errorDetail}`));
      }
    });

    rg.on("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "UNKNOWN";
      reject(
        new Error(
          `Failed to spawn ripgrep (${code}): ${err.message}. ` +
            `Path: "${rgPath}", cwd: "${cwd}"`
        )
      );
    });
  });
}

const inputSchema = z.object({
  pattern: z
    .string()
    .describe(
      "Pattern to search (regex by default). " +
        "Use '\\b' for word boundaries: '\\bfunctionName\\b'"
    ),
  path: z
    .string()
    .optional()
    .describe("Directory to search (default: current directory)"),
  include: z
    .string()
    .optional()
    .describe("Filter files by glob (e.g., '*.ts', 'src/**')"),
  case_sensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Case-sensitive search (default: false)"),
  fixed_strings: z
    .boolean()
    .optional()
    .default(false)
    .describe("Treat pattern as literal string (default: false)"),
  context: z.number().optional().describe("Lines of context around matches"),
  before: z.number().optional().describe("Lines before matches"),
  after: z.number().optional().describe("Lines after matches"),
  no_ignore: z
    .boolean()
    .optional()
    .default(false)
    .describe("Search .gitignore files too (default: false)"),
});

export type GrepInput = z.input<typeof inputSchema>;

/**
 * Resolve a path to a valid search directory.
 * If path is a file, returns its parent directory.
 * If path doesn't exist, throws an error.
 */
function resolveSearchDir(path: string | undefined): string {
  if (!path) {
    return process.cwd();
  }

  const resolved = resolve(path);

  if (!existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }

  const stats = statSync(resolved);
  if (stats.isFile()) {
    // If a file path was provided, use its parent directory
    return dirname(resolved);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }

  return resolved;
}

export async function executeGrep({
  pattern,
  path,
  include,
  case_sensitive = false,
  fixed_strings = false,
  context,
  before,
  after,
  no_ignore = false,
}: GrepInput): Promise<string> {
  const searchDir = resolveSearchDir(path);

  const args: string[] = ["--line-number", "--with-filename", "--color=never"];

  if (!case_sensitive) {
    args.push("--ignore-case");
  }

  if (fixed_strings) {
    args.push("--fixed-strings");
  }

  if (include) {
    args.push("--glob", include);
  }

  if (context !== undefined) {
    args.push("--context", context.toString());
  }

  if (before !== undefined) {
    args.push("--before-context", before.toString());
  }

  if (after !== undefined) {
    args.push("--after-context", after.toString());
  }

  if (no_ignore) {
    args.push("--no-ignore");
  }

  args.push("--", pattern, ".");

  const result = await runRipgrep(args, searchDir);
  const formattedMatches = formatHashlineCompatibleMatches(result.matches);

  const output = [
    result.matchCount > 0 ? "OK - grep" : "OK - grep (no matches)",
    `pattern: "${pattern}"`,
    `path: ${path ?? "."}`,
    `include: ${include ?? "*"}`,
    `case_sensitive: ${case_sensitive}`,
    `fixed_strings: ${fixed_strings}`,
    `match_count: ${result.matchCount}`,
    `truncated: ${result.truncated}`,
    "",
  ];

  if (result.matchCount > 0) {
    output.push(formatBlock("grep results", formattedMatches));
  } else {
    output.push(formatBlock("grep results", "(no matches)"));
  }

  return output.join("\n");
}

export const grepTool = tool({
  description: GREP_FILES_DESCRIPTION,
  inputSchema,
  execute: executeGrep,
});
