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

function parseKeys(input: string): string[] {
  const keys: string[] = [];
  let i = 0;

  while (i < input.length) {
    let matched = false;

    for (const [name, tmuxKey] of Object.entries(SPECIAL_KEYS)) {
      if (input.slice(i).toLowerCase().startsWith(`<${name}>`)) {
        keys.push(tmuxKey);
        i += name.length + 2;
        matched = true;
        break;
      }
    }

    if (!matched) {
      keys.push(input[i]);
      i++;
    }
  }

  return keys;
}

export interface InteractResult {
  success: boolean;
  output: string;
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
