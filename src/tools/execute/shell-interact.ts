import { tool } from "ai";
import { z } from "zod";
import { formatTerminalScreen } from "./format-utils";
import { isInteractiveState } from "./interactive-detector";
import { getSharedSession } from "./shared-tmux-session";

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

export const shellInteractTool = tool({
  description:
    "Send keystrokes to terminal (same session as shell_execute). " +
    "MUST include '<Enter>' to execute. " +
    "Use for: prompts (y/n), interactive programs, timeout recovery ('<Ctrl+C>').",

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

  execute: async ({ keystrokes, timeout_ms }): Promise<InteractResult> => {
    const session = getSharedSession();
    const parsedKeys = parseKeys(keystrokes);
    const waitTime = timeout_ms ?? 500;

    const output = await session.sendKeys(parsedKeys, {
      block: false,
      minTimeoutMs: waitTime,
    });

    const formattedOutput = formatTerminalScreen(output);
    const interactiveResult = isInteractiveState(session.getSessionId());

    if (interactiveResult.isInteractive) {
      const reminder = [
        `[SYSTEM REMINDER] Terminal is in interactive state (foreground: ${interactiveResult.currentProcess})`,
        "Use shell_interact to continue interacting with the process.",
      ].join("\n");

      return {
        success: true,
        output: `${formattedOutput}\n\n${reminder}`,
      };
    }

    return {
      success: true,
      output: formattedOutput,
    };
  },
});
