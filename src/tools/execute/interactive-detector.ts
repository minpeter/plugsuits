import { spawnSync } from "node:child_process";

const KNOWN_SHELLS = [
  "bash",
  "zsh",
  "sh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
];

export interface InteractiveStateResult {
  isInteractive: boolean;
  currentProcess: string | null;
}

export function checkForegroundProcess(sessionId: string): string | null {
  try {
    const result = spawnSync(
      "/bin/bash",
      ["-c", `tmux display -t ${sessionId} -p "#{pane_current_command}"`],
      { encoding: "utf-8" }
    );

    if (result.status !== 0 || !result.stdout.trim()) {
      return null;
    }

    return result.stdout.trim();
  } catch {
    return null;
  }
}

export function isInteractiveState(sessionId: string): InteractiveStateResult {
  const currentProcess = checkForegroundProcess(sessionId);

  if (currentProcess === null) {
    return { isInteractive: false, currentProcess: null };
  }

  const isShell = KNOWN_SHELLS.includes(currentProcess.toLowerCase());

  return {
    isInteractive: !isShell,
    currentProcess,
  };
}
