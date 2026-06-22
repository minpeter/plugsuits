import { existsSync } from "node:fs";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { readTextAsset } from "../../utils/text-asset";
import {
  formatBackgroundMessage,
  formatTimeoutMessage,
} from "../utils/execute/format-utils";
import { executeCommand as pmExecuteCommand } from "../utils/execute/process-manager";

const SHELL_EXECUTE_DESCRIPTION = readTextAsset(
  "./shell-execute.txt",
  import.meta.url
);

const DEFAULT_TIMEOUT_MS = 120_000;
const FORBIDDEN_FILE_INSPECTION_PATTERN =
  /(^|\s)(cat|head|tail|sed|awk|wc)\s+[^|;&]*\.(ts|tsx|js|jsx|json|md|py|go|rs)\b/;
const FORBIDDEN_DIRECTORY_LIST_PATTERN = /(^|\s)ls(\s|$)/;
const NPM_COMMAND_PATTERN = /(^|\s)npm(\s|$)/;

function usesNpmInPnpmRepo(command: string, workdir?: string): boolean {
  const effectiveDir = workdir ?? process.cwd();
  if (!existsSync(join(effectiveDir, "pnpm-lock.yaml"))) {
    return false;
  }
  return NPM_COMMAND_PATTERN.test(command);
}

function isBackgroundCommand(command: string): boolean {
  const trimmed = command.trimEnd();
  return trimmed.endsWith("&") && !trimmed.endsWith("&&");
}

export interface ToolOutput {
  exit_code: number;
  output: string;
}

export async function executeCommand(
  command: string,
  options: { workdir?: string; timeoutMs?: number } = {}
): Promise<{ exitCode: number; output: string }> {
  const { workdir, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  if (FORBIDDEN_FILE_INSPECTION_PATTERN.test(command)) {
    return {
      exitCode: 2,
      output:
        "Use read_file, grep_files, or glob_files instead of shell file-inspection commands like cat/head/tail/wc/sed/awk for source files.",
    };
  }

  if (FORBIDDEN_DIRECTORY_LIST_PATTERN.test(command)) {
    return {
      exitCode: 2,
      output:
        "Use glob_files instead of ls for directory discovery so the model gets structured results without wasting tool turns.",
    };
  }

  if (usesNpmInPnpmRepo(command, workdir)) {
    return {
      exitCode: 2,
      output:
        "This repository uses pnpm. Use pnpm instead of npm for install/test/run commands in a pnpm workspace.",
    };
  }

  const result = await pmExecuteCommand(command, { workdir, timeoutMs });

  if (result.timedOut) {
    return {
      exitCode: result.exitCode,
      output: formatTimeoutMessage(timeoutMs, result.output),
    };
  }

  if (isBackgroundCommand(command)) {
    return {
      exitCode: result.exitCode,
      output: formatBackgroundMessage(result.output),
    };
  }

  return {
    exitCode: result.exitCode,
    output: result.output,
  };
}

export const shellExecuteTool = tool({
  description: SHELL_EXECUTE_DESCRIPTION,
  needsApproval: true,

  inputSchema: z.object({
    command: z.string().describe("Shell command to execute"),
    workdir: z
      .string()
      .optional()
      .describe("Working directory (absolute path)"),
    timeout_ms: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 120000)"),
  }),

  execute: async ({ command, workdir, timeout_ms }): Promise<ToolOutput> => {
    const result = await executeCommand(command, {
      workdir,
      timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
    });
    return {
      exit_code: result.exitCode,
      output: result.output,
    };
  },
});
