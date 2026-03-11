import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeCommand,
  getActiveProcessesForTesting,
  hasPendingSigkillTimeoutForTesting,
  killProcessTree,
  resetProcessManagerForTesting,
  trackActiveProcessForTesting,
  untrackActiveProcessForTesting,
} from "./process-manager";
import { getShell, getShellArgs } from "./shell-detection";

const FIVE_SECONDS_MS = 5000;
const SIGKILL_GRACE_MS = 1000;
const ABORT_DELAY_MS = 50;
const SHORT_TIMEOUT_MS = 100;

function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrnoCode(error, "EPERM");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("process-manager", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "process-manager-test-"));
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns exact command result for echo hello", async () => {
    const result = await executeCommand("echo hello");

    expect(result).toEqual({
      exitCode: 0,
      output: "hello\n",
      cancelled: false,
      timedOut: false,
    });
  });

  it("returns non-zero exit code for failing command", async () => {
    const result = await executeCommand("exit 1");

    expect(result.exitCode).toBe(1);
    expect(result.cancelled).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("executes commands in provided workdir", async () => {
    const result = await executeCommand("pwd", { workdir: tempDir });
    const actualWorkdir = realpathSync(result.output.trim());
    const expectedWorkdir = realpathSync(tempDir);

    expect(result.exitCode).toBe(0);
    expect(actualWorkdir).toBe(expectedWorkdir);
  });

  it("uses stdin ignore by default", async () => {
    const startedAt = Date.now();
    const result = await executeCommand("cat", { timeoutMs: FIVE_SECONDS_MS });
    const elapsed = Date.now() - startedAt;

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(elapsed).toBeLessThan(FIVE_SECONDS_MS);
  });

  it("streams combined chunks through onChunk callback", async () => {
    const streamedChunks: string[] = [];

    const result = await executeCommand(
      "printf 'stdout-chunk'; printf 'stderr-chunk' >&2",
      {
        onChunk: (chunk) => {
          streamedChunks.push(chunk);
        },
      }
    );

    const streamedOutput = streamedChunks.join("");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("stdout-chunk");
    expect(result.output).toContain("stderr-chunk");
    expect(streamedChunks.length).toBeGreaterThan(0);
    expect(streamedOutput).toContain("stdout-chunk");
    expect(streamedOutput).toContain("stderr-chunk");
  });

  it("sets timedOut=true and kills process within 5 seconds", async () => {
    const startedAt = Date.now();
    const result = await executeCommand("trap '' TERM; sleep 30", {
      timeoutMs: SHORT_TIMEOUT_MS,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(elapsed).toBeLessThan(FIVE_SECONDS_MS);
  }, 10_000);

  it("supports AbortSignal cancellation", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const command = executeCommand("sleep 30", { signal: controller.signal });

    setTimeout(() => {
      controller.abort();
    }, ABORT_DELAY_MS);

    const result = await command;
    const elapsed = Date.now() - startedAt;

    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(130);
    expect(elapsed).toBeLessThan(FIVE_SECONDS_MS);
  }, 10_000);

  it("killProcessTree terminates detached process groups", async () => {
    const shell = getShell();
    const shellArgs = getShellArgs(shell);
    const child = spawn(shell, [...shellArgs, "trap '' TERM; sleep 30"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const pid = child.pid;
    expect(pid).toBeDefined();

    if (!pid) {
      throw new Error("Expected detached child pid to be defined");
    }

    try {
      await sleep(ABORT_DELAY_MS);
      // Register pid in activeProcesses so SIGKILL guard allows the kill
      trackActiveProcessForTesting(pid);
      killProcessTree(pid);
      await sleep(SIGKILL_GRACE_MS);

      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      killProcessTree(pid, true);
      resetProcessManagerForTesting();
    }
  }, 10_000);

  it("does not use spawnSync", async () => {
    const tsUrl = new URL("./process-manager.ts", import.meta.url);
    const jsUrl = new URL("./process-manager.js", import.meta.url);
    let source: string;
    try {
      source = await Bun.file(tsUrl).text();
    } catch {
      source = await Bun.file(jsUrl).text();
    }

    expect(source.includes("spawnSync")).toBe(false);
  });

  it("activeProcesses is empty after executeCommand completes", async () => {
    resetProcessManagerForTesting();
    await executeCommand("echo hello");
    expect(getActiveProcessesForTesting()).toHaveLength(0);
  });

  it("killProcessTree skips SIGKILL when pid removed from activeProcesses before timeout", async () => {
    const shell = getShell();
    const shellArgs = getShellArgs(shell);
    const child = spawn(shell, [...shellArgs, "trap '' TERM; exec sleep 30"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const pid = child.pid;
    expect(pid).toBeDefined();
    if (!pid) {
      throw new Error("Expected pid to be defined");
    }

    child.unref();
    await sleep(ABORT_DELAY_MS);

    // killProcessTree adds pid to activeProcesses then schedules SIGKILL
    killProcessTree(pid);
    expect(hasPendingSigkillTimeoutForTesting(pid)).toBe(true);

    // Simulate finish() by removing pid from activeProcesses BEFORE the SIGKILL fires.
    // The guard in the timeout callback: if (!activeProcesses.has(pid)) return;
    // will detect the removal and skip the SIGKILL.
    untrackActiveProcessForTesting(pid);

    // Wait past SIGKILL_DELAY_MS (200ms) to confirm SIGKILL was not sent
    await sleep(400);
    const aliveAfterDelay = isProcessAlive(pid);

    // Force cleanup now
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ignore
    }
    await sleep(200);

    // Process should still have been alive when we checked (guard blocked SIGKILL)
    expect(aliveAfterDelay).toBe(true);
  }, 10_000);

  it("finish() clears pending SIGKILL timeout when process exits from SIGTERM", async () => {
    resetProcessManagerForTesting();

    const controller = new AbortController();
    const commandPromise = executeCommand("sleep 30", {
      signal: controller.signal,
    });

    // Let the process spawn and register in activeProcesses
    await sleep(10);
    const pids = getActiveProcessesForTesting();
    expect(pids.length).toBe(1);
    const pid = pids[0];
    if (pid === undefined) {
      throw new Error("Expected pid");
    }

    // Abort — triggers killProcessTree which sets a SIGKILL timer
    controller.abort();
    expect(hasPendingSigkillTimeoutForTesting(pid)).toBe(true);

    // Wait for process to exit; finish() calls clearScheduledSigkill(pid)
    const result = await commandPromise;
    expect(hasPendingSigkillTimeoutForTesting(pid)).toBe(false);
    expect(getActiveProcessesForTesting()).not.toContain(pid);
    expect(result.cancelled).toBe(true);
  }, 10_000);
});
