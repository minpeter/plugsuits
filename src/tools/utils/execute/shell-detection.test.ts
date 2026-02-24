import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getShell, getShellArgs } from "./shell-detection";

const SHELL_DETECTION_SCRIPT =
  "import { getShell } from './src/tools/utils/execute/shell-detection'; console.log(getShell());";

function runShellDetectionWithEnv(shellPath: string): string {
  const env = { ...process.env, SHELL: shellPath };
  const result = spawnSync(process.execPath, ["-e", SHELL_DETECTION_SCRIPT], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout) {
    throw new Error("Failed to evaluate getShell in child process");
  }

  return result.stdout.trim();
}

function createFakeShell(shellName: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), "shell-detection-"));
  const shellPath = join(tempDir, shellName);
  writeFileSync(shellPath, "#!/bin/sh\n");
  return shellPath;
}

function removeFakeShell(shellPath: string): void {
  rmSync(shellPath, { force: true });
  rmSync(dirname(shellPath), { recursive: true, force: true });
}

function getFallbackCandidates(): string[] {
  if (platform() === "darwin") {
    return ["/bin/zsh", "/bin/bash", "/bin/sh"];
  }

  if (platform() === "linux") {
    return ["/bin/bash", "/bin/sh"];
  }

  return ["C:\\Program Files\\Git\\bin\\bash.exe", "cmd.exe"];
}

describe("shell detection", () => {
  test("returns a valid shell path", () => {
    const shell = getShell();

    expect(typeof shell).toBe("string");
    expect(shell.length).toBeGreaterThan(0);
    expect(existsSync(shell)).toBe(true);
  });

  test("returns cached shell path on repeated calls", () => {
    const first = getShell();
    const second = getShell();

    expect(first).toBe(second);
  });

  test("uses explicit SHELL path when valid", () => {
    const fakeShell = createFakeShell("zsh-shell");
    try {
      const shell = runShellDetectionWithEnv(fakeShell);
      expect(shell).toBe(fakeShell);
    } finally {
      removeFakeShell(fakeShell);
    }
  });

  test("falls back when SHELL is rejected", () => {
    const fakeRejectedShell = createFakeShell("fish");
    try {
      const shell = runShellDetectionWithEnv(fakeRejectedShell);
      const candidates = getFallbackCandidates();
      const availableFallback = candidates.find((candidate) =>
        existsSync(candidate)
      );

      if (availableFallback) {
        expect(shell).toBe(availableFallback);
      }
      expect(shell).not.toBe(fakeRejectedShell);
      expect(existsSync(shell)).toBe(true);
    } finally {
      removeFakeShell(fakeRejectedShell);
    }
  });

  test("returns args for unix shell format", () => {
    expect(getShellArgs("/bin/bash")).toEqual(["-c"]);
    expect(getShellArgs("/usr/bin/sh")).toEqual(["-c"]);
  });

  test("returns args for cmd.exe", () => {
    expect(getShellArgs("C:\\Windows\\System32\\cmd.exe")).toEqual(["/c"]);
  });
});
