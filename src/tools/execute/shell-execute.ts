import { tool } from "ai";
import { z } from "zod";
import {
  formatBackgroundMessage,
  formatTimeoutMessage,
} from "../utils/execute/format-utils";
import { executeCommand as pmExecuteCommand } from "../utils/execute/process-manager";
import SHELL_EXECUTE_DESCRIPTION from "./shell-execute.txt";

const DEFAULT_TIMEOUT_MS = 120_000;

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
