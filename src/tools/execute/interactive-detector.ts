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
  "ash", // busybox/Alpine
  "pwsh", // PowerShell Core
];

const SESSION_ID_PATTERN = /^[\w.-]+$/;

export interface InteractiveStateResult {
  currentProcess: string | null;
  isInteractive: boolean;
  reason?: string;
}

interface TmuxPaneState {
  currentCommand: string;
  inMode: boolean;
  isDead: boolean;
}

function validateSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

function queryTmuxPaneState(sessionId: string): TmuxPaneState | null {
  if (!validateSessionId(sessionId)) {
    return null;
  }

  try {
    const result = spawnSync(
      "tmux",
      [
        "display",
        "-t",
        sessionId,
        "-p",
        "#{pane_in_mode} #{pane_dead} #{pane_current_command}",
      ],
      { encoding: "utf-8", timeout: 5000 }
    );

    if (result.status !== 0 || !result.stdout.trim()) {
      return null;
    }

    const output = result.stdout.trim();
    const parts = output.split(" ");

    if (parts.length < 3) {
      return null;
    }

    const inMode = parts[0] === "1";
    const isDead = parts[1] === "1";
    const currentCommand = parts.slice(2).join(" ");

    return {
      currentCommand,
      inMode,
      isDead,
    };
  } catch {
    return null;
  }
}

export function checkForegroundProcess(sessionId: string): string | null {
  const state = queryTmuxPaneState(sessionId);
  return state?.currentCommand ?? null;
}

export function isInteractiveState(sessionId: string): InteractiveStateResult {
  const state = queryTmuxPaneState(sessionId);

  // Fail-closed: if we can't query tmux, assume interactive (safer)
  if (state === null) {
    return {
      isInteractive: true,
      currentProcess: null,
      reason: "tmux_query_failed",
    };
  }

  // Pane is dead - treat as interactive/blocked
  if (state.isDead) {
    return {
      isInteractive: true,
      currentProcess: state.currentCommand,
      reason: "pane_dead",
    };
  }

  // Pane is in copy-mode or other mode - treat as interactive
  if (state.inMode) {
    return {
      isInteractive: true,
      currentProcess: state.currentCommand,
      reason: "pane_in_mode",
    };
  }

  const isShell = KNOWN_SHELLS.includes(state.currentCommand.toLowerCase());

  return {
    isInteractive: !isShell,
    currentProcess: state.currentCommand,
  };
}
