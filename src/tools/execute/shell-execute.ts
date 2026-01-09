import { tool } from "ai";
import { z } from "zod";
import { getSharedSession } from "./shared-tmux-session";

const MAX_OUTPUT_LENGTH = 50_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface CommandResult {
  exitCode: number;
  output: string;
}

export class CommandError extends Error {
  command: string;

  constructor(message: string, command: string) {
    super(message);
    this.name = "CommandError";
    this.command = command;
  }
}

function truncateOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) {
    return output;
  }
  const half = Math.floor(maxLength / 2);
  const first = output.slice(0, half);
  const last = output.slice(-half);
  const omitted = output.length - maxLength;
  return `${first}\n[... ${omitted} characters omitted ...]\n${last}`;
}

export async function executeCommand(
  command: string,
  options: { workdir?: string; timeoutMs?: number } = {}
): Promise<CommandResult> {
  const { workdir, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const session = getSharedSession();

  const result = await session.executeCommand(command, { workdir, timeoutMs });

  return {
    exitCode: result.exitCode,
    output: truncateOutput(result.output, MAX_OUTPUT_LENGTH),
  };
}

export const shellExecuteTool = tool({
  description:
    "Execute shell commands (git, npm, build, tests). " +
    "Shares terminal session with shell_interact. " +
    "10s timeout (configurable). On timeout, use shell_interact with '<Ctrl+C>' to interrupt.",

  inputSchema: z.object({
    command: z.string().describe("Shell command to execute"),
    workdir: z
      .string()
      .optional()
      .describe("Working directory (absolute path)"),
    timeout_ms: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 10000)"),
  }),

  needsApproval: true,

  execute: async ({ command, workdir, timeout_ms }): Promise<CommandResult> => {
    return await executeCommand(command, { workdir, timeoutMs: timeout_ms });
  },
});
