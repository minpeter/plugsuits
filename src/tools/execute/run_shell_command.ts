import { exec } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";

export interface CommandResult {
  output: string;
  error: string;
  command: string;
  exitCode: number;
}

class CommandError extends Error {
  command: string;
  stderr?: string;
  exitCode?: number;

  constructor(
    message: string,
    command: string,
    stderr?: string,
    exitCode?: number
  ) {
    super(message);
    this.name = "CommandError";
    this.command = command;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export const runShellCommandTool = tool({
  description: "Execute a shell command and return the output",
  inputSchema: z.object({
    command: z
      .string()
      .describe(
        "The command to execute (e.g., 'ls -la', 'node -v', 'git status')"
      ),
  }),
  needsApproval: true,
  execute: ({ command }): Promise<CommandResult> => {
    return new Promise<CommandResult>((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        const exitCode = error?.code ?? 0;

        if (error) {
          reject(new CommandError(error.message, command, stderr, exitCode));
        } else {
          resolve({
            output: stdout.trim(),
            error: stderr.trim(),
            command,
            exitCode,
          });
        }
      });
    });
  },
});
