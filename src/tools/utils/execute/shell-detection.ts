import { existsSync } from "node:fs";
import { platform } from "node:os";
import { basename, win32 } from "node:path";

const REJECTED_SHELL_BASENAMES = new Set(["fish", "nu", "csh", "tcsh"]);
const WINDOWS_GIT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";
const WINDOWS_CMD_PATH = "cmd.exe";

let cachedShell: string | null = null;

function resolveShellBasenames(shellPath: string): Set<string> {
  const primary = basename(shellPath).toLowerCase();
  const windows = win32.basename(shellPath).toLowerCase();
  return primary === windows ? new Set([primary]) : new Set([primary, windows]);
}

function isRejectedShell(shellPath: string): boolean {
  return [...resolveShellBasenames(shellPath)].some((name) =>
    REJECTED_SHELL_BASENAMES.has(name)
  );
}

function getPlatformShellOptions(): string[] {
  if (platform() === "darwin") {
    return ["/bin/zsh", "/bin/bash", "/bin/sh"];
  }

  if (platform() === "linux") {
    return ["/bin/bash", "/bin/sh"];
  }

  return [WINDOWS_GIT_BASH_PATH, WINDOWS_CMD_PATH];
}

function firstExistingShell(shells: string[]): string | null {
  for (const shell of shells) {
    if (existsSync(shell)) {
      return shell;
    }
  }

  return null;
}

export function getShell(): string {
  if (cachedShell) {
    return cachedShell;
  }

  const envShell = process.env.SHELL?.trim();
  if (envShell && existsSync(envShell) && !isRejectedShell(envShell)) {
    cachedShell = envShell;
    return cachedShell;
  }

  const shell = firstExistingShell(getPlatformShellOptions());
  if (shell) {
    cachedShell = shell;
    return shell;
  }

  cachedShell = platform() === "win32" ? WINDOWS_CMD_PATH : "/bin/sh";
  return cachedShell;
}

export function getShellArgs(shell: string): string[] {
  if (resolveShellBasenames(shell).has("cmd.exe")) {
    return ["/c"];
  }

  return ["-c"];
}
