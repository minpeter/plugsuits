import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";

const MAX_OUTPUT_LENGTH = 50_000;

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
  const truncated = output.slice(-maxLength);
  return `[... ${output.length - maxLength} characters truncated ...]\n${truncated}`;
}

export function executeCommand(
  command: string,
  options: { workdir?: string } = {}
): Promise<CommandResult> {
  const { workdir } = options;

  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", command], {
      cwd: workdir ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LANG: "en_US.UTF-8" },
    });

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let resolved = false;

    const tryResolve = () => {
      if (resolved || exitCode === null) {
        return;
      }

      resolved = true;
      const combined = stdout + stderr;
      resolve({
        exitCode,
        output: truncateOutput(combined.trim(), MAX_OUTPUT_LENGTH),
      });
    };

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("exit", (code) => {
      exitCode = code ?? 0;
      setTimeout(tryResolve, 10);
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(new CommandError(`Failed to execute: ${err.message}`, command));
      }
    });
  });
}

export const runShellCommandTool = tool({
  description: `Execute a shell command and return the output.

Parameters:
- command (required): The shell command to execute
- workdir (optional): Absolute path for command execution

Constraints:
- Do NOT use & for background processes
- Do NOT use interactive commands (REPLs, editors, password prompts)
- Output is truncated to last 50000 characters
- Environment variables and \`cd\` do NOT persist between tool calls
- Commands run in workspace root by default
- Only use workdir parameter for different directory`,

  inputSchema: z.object({
    command: z.string().describe("The shell command to execute"),
    workdir: z
      .string()
      .optional()
      .describe("Absolute path for command execution"),
  }),

  needsApproval: true,

  execute: ({ command, workdir }): Promise<CommandResult> => {
    return executeCommand(command, { workdir });
  },
});
