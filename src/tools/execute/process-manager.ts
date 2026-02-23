import { spawn } from "node:child_process";
import { getFullWrappedCommand as wrapCommand } from "./noninteractive-wrapper";
import { sanitizeOutput, truncateOutput } from "./output-handler";
import { getShell, getShellArgs } from "./shell-detection";

const DEFAULT_TIMEOUT_MS = 120_000;
const SIGKILL_DELAY_MS = 200;
const SPAWN_ERROR_EXIT_CODE = 1;
const CANCELLED_EXIT_CODE = 130;
const TIMEOUT_EXIT_CODE = 124;

export interface ExecuteOptions {
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
  stdin?: "ignore" | "pipe";
  timeoutMs?: number;
  workdir?: string;
}

export interface ExecuteResult {
  cancelled: boolean;
  exitCode: number;
  output: string;
  timedOut: boolean;
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return hasErrnoCode(error, "EPERM");
  }
}

function safeKillProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!hasErrnoCode(error, "ESRCH")) {
      return;
    }
  }
}

function resolveExitCode(
  code: number | null,
  timedOut: boolean,
  cancelled: boolean,
  spawnFailed: boolean
): number {
  if (typeof code === "number") {
    return code;
  }

  if (timedOut) {
    return TIMEOUT_EXIT_CODE;
  }

  if (cancelled) {
    return CANCELLED_EXIT_CODE;
  }

  if (spawnFailed) {
    return SPAWN_ERROR_EXIT_CODE;
  }

  return SPAWN_ERROR_EXIT_CODE;
}

export function killProcessTree(pid: number): void {
  if (pid <= 0) {
    return;
  }

  safeKillProcessGroup(pid, "SIGTERM");

  setTimeout(() => {
    if (!isProcessGroupAlive(pid)) {
      return;
    }
    safeKillProcessGroup(pid, "SIGKILL");
  }, SIGKILL_DELAY_MS);
}

export async function executeCommand(
  command: string,
  options: ExecuteOptions = {}
): Promise<ExecuteResult> {
  const {
    workdir,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    onChunk,
    stdin = "ignore",
  } = options;

  if (signal?.aborted) {
    return {
      exitCode: CANCELLED_EXIT_CODE,
      output: "",
      cancelled: true,
      timedOut: false,
    };
  }

  const shell = getShell();
  const shellArgs = getShellArgs(shell);
  const wrappedCommand = wrapCommand(command);

  return await new Promise<ExecuteResult>((resolve) => {
    const child = spawn(shell, [...shellArgs, wrappedCommand], {
      detached: true,
      stdio: [stdin, "pipe", "pipe"],
      cwd: workdir,
      env: {
        ...process.env,
        TERM: "dumb",
      },
    });

    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    const chunks: string[] = [];

    let timedOut = false;
    let cancelled = false;
    let spawnFailed = false;
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        killProcessTree(child.pid);
      }
    }, timeoutMs);

    const abortHandler = () => {
      cancelled = true;
      if (child.pid) {
        killProcessTree(child.pid);
      }
    };

    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    const appendChunk = (chunk: Buffer, decoder: TextDecoder): void => {
      const decoded = decoder.decode(chunk, { stream: true });
      chunks.push(decoded);
      onChunk?.(decoded);
    };

    const flushDecoder = (decoder: TextDecoder): void => {
      const remaining = decoder.decode();
      if (!remaining) {
        return;
      }
      chunks.push(remaining);
      onChunk?.(remaining);
    };

    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;

      clearTimeout(timeoutHandle);
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }

      flushDecoder(stdoutDecoder);
      flushDecoder(stderrDecoder);

      const sanitizedOutput = sanitizeOutput(chunks.join(""));
      const truncatedOutput = truncateOutput(sanitizedOutput);

      resolve({
        exitCode: resolveExitCode(code, timedOut, cancelled, spawnFailed),
        output: truncatedOutput.text,
        cancelled,
        timedOut,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      appendChunk(chunk, stdoutDecoder);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      appendChunk(chunk, stderrDecoder);
    });

    child.on("close", (code) => {
      finish(code);
    });

    child.on("error", (error) => {
      spawnFailed = true;
      chunks.push(`${(error as Error).message}\n`);
      finish(null);
    });
  });
}

export function cleanup(): void {
  return;
}
