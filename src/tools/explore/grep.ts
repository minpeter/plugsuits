import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";

const MAX_MATCHES = 20_000;

interface GrepResult {
  matches: string;
  matchCount: number;
  truncated: boolean;
}

function runRipgrep(args: string[], cwd: string): Promise<GrepResult> {
  return new Promise((resolve, reject) => {
    const rg = spawn("rg", args, { cwd });

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
        // code 1 means no matches found, which is not an error
        const lines = stdout.split("\n").filter((line) => line.length > 0);
        const truncated = lines.length > MAX_MATCHES;
        const result = truncated
          ? lines.slice(0, MAX_MATCHES).join("\n")
          : stdout.trim();

        resolve({
          matches: result,
          matchCount: Math.min(lines.length, MAX_MATCHES),
          truncated,
        });
      } else {
        reject(new Error(`ripgrep failed with code ${code}: ${stderr}`));
      }
    });

    rg.on("error", (err) => {
      reject(new Error(`Failed to spawn ripgrep: ${err.message}`));
    });
  });
}

export const grepTool = tool({
  description:
    "Search file contents (regex or literal). " +
    "Returns matches with file:line:content format. " +
    "Powered by ripgrep.",
  inputSchema: z.object({
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
  }),
  execute: async ({
    pattern,
    path,
    include,
    case_sensitive,
    fixed_strings,
    context,
    before,
    after,
    no_ignore,
  }) => {
    const searchDir = path ? resolve(path) : process.cwd();

    const args: string[] = [
      "--line-number",
      "--with-filename",
      "--color=never",
    ];

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

    try {
      const result = await runRipgrep(args, searchDir);

      if (result.matchCount === 0) {
        return JSON.stringify({
          matches: [],
          message: "No matches found",
        });
      }

      let output = result.matches;
      if (result.truncated) {
        output += `

[Output truncated: showing ${MAX_MATCHES} of ${result.matchCount}+ matches]`;
      }

      return output;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Search failed: ${error.message}`);
      }
      throw error;
    }
  },
});
