import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  getShell,
  getShellArgs,
  resetCacheForTesting,
} from "./shell-detection";

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

function restoreShell(originalShell: string | undefined): void {
  if (originalShell === undefined) {
    Reflect.deleteProperty(process.env, "SHELL");
    return;
  }

  process.env.SHELL = originalShell;
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
  beforeEach(() => {
    resetCacheForTesting();
  });

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
    const originalShell = process.env.SHELL;
    try {
      process.env.SHELL = fakeShell;
      const shell = getShell();
      expect(shell).toBe(fakeShell);
    } finally {
      restoreShell(originalShell);
      resetCacheForTesting();
      removeFakeShell(fakeShell);
    }
  });

  test("falls back when SHELL is rejected", () => {
    const fakeRejectedShell = createFakeShell("fish");
    const originalShell = process.env.SHELL;
    try {
      process.env.SHELL = fakeRejectedShell;
      const shell = getShell();
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
      restoreShell(originalShell);
      resetCacheForTesting();
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
