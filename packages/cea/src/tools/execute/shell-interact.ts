import { tool } from "ai";
import { z } from "zod";
import SHELL_INTERACT_DESCRIPTION from "./shell-interact.txt";

const SPECIAL_KEYS: Record<string, string> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "BSpace",
  delete: "DC",
  del: "DC",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PPage",
  pagedown: "NPage",
  space: "Space",
  "ctrl+c": "C-c",
  "ctrl+d": "C-d",
  "ctrl+z": "C-z",
  "ctrl+l": "C-l",
  "ctrl+a": "C-a",
  "ctrl+e": "C-e",
  "ctrl+k": "C-k",
  "ctrl+u": "C-u",
  "ctrl+w": "C-w",
  "ctrl+r": "C-r",
};

const HTML_TOKEN_START = "&lt;";
const HTML_TOKEN_END = "&gt;";
const HTML_AMP_PATTERN = /&amp;/gi;
const CTRL_DASH_SHORTCUT_PATTERN = /^c-[a-z]$/;
const CTRL_DASH_PATTERN = /^ctrl-[a-z]$/;

function normalizeSpecialToken(token: string): string {
  const compact = token.toLowerCase().replace(/\s+/g, "");

  if (CTRL_DASH_SHORTCUT_PATTERN.test(compact)) {
    return `ctrl+${compact[2]}`;
  }

  if (CTRL_DASH_PATTERN.test(compact)) {
    return `ctrl+${compact[5]}`;
  }

  return compact;
}

function mapSpecialToken(token: string): string | undefined {
  const normalizedToken = normalizeSpecialToken(token);
  return SPECIAL_KEYS[normalizedToken];
}

export function parseKeys(input: string): string[] {
  const keys: string[] = [];
  let i = 0;

  while (i < input.length) {
    const current = input[i];

    if (current === "<") {
      const closingIndex = input.indexOf(">", i + 1);
      if (closingIndex !== -1) {
        const token = input.slice(i + 1, closingIndex);
        const mappedKey = mapSpecialToken(token);

        if (mappedKey) {
          keys.push(mappedKey);
          i = closingIndex + 1;
          continue;
        }
      }
    }

    if (input.startsWith(HTML_TOKEN_START, i)) {
      const tokenStart = i + HTML_TOKEN_START.length;
      const encodedClosingIndex = input.indexOf(HTML_TOKEN_END, tokenStart);
      if (encodedClosingIndex !== -1) {
        const encodedToken = input.slice(tokenStart, encodedClosingIndex);
        const token = encodedToken.replace(HTML_AMP_PATTERN, "&");
        const mappedKey = mapSpecialToken(token);

        if (mappedKey) {
          keys.push(mappedKey);
          i = encodedClosingIndex + HTML_TOKEN_END.length;
          continue;
        }
      }
    }

    keys.push(current);
    i++;
  }

  return keys;
}

export interface InteractResult {
  output: string;
  success: boolean;
}

const DEFAULT_SHELL_EXECUTE_TIMEOUT_SEC = 120;

const CTRL_C_GUIDANCE = [
  "No retained terminal context exists. Each shell_execute command runs independently.",
  `To interrupt a long-running command, wait for its timeout (default: ${DEFAULT_SHELL_EXECUTE_TIMEOUT_SEC}s) or use shell_execute to kill the process by PID:`,
  '  shell_execute({ command: "kill -SIGINT <PID>" })',
].join("\n");

const GENERIC_GUIDANCE = [
  "No retained terminal context exists. Each shell_execute command runs independently.",
  "To run a command, use shell_execute directly:",
  '  shell_execute({ command: "your command here" })',
].join("\n");

function hasCtrlC(parsedKeys: string[]): boolean {
  return parsedKeys.includes("C-c");
}

export const shellInteractTool = tool({
  description: SHELL_INTERACT_DESCRIPTION,

  inputSchema: z.object({
    keystrokes: z
      .string()
      .describe(
        "Keystrokes to send. Use <SpecialKey> syntax. " +
          "Examples: 'y<Enter>', '<Ctrl+C>', 'ls<Enter>'"
      ),
    timeout_ms: z
      .number()
      .optional()
      .describe("Wait time after sending keys (default: 500)"),
  }),

  execute: ({ keystrokes }): Promise<InteractResult> => {
    const parsedKeys = parseKeys(keystrokes);
    const guidance = hasCtrlC(parsedKeys) ? CTRL_C_GUIDANCE : GENERIC_GUIDANCE;

    return Promise.resolve({
      success: true,
      output: guidance,
    });
  },
});
