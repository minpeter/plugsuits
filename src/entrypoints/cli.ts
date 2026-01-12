#!/usr/bin/env bun

import type { Interface as ReadlineInterface } from "node:readline";
import { createInterface } from "node:readline";
import { agentManager } from "../agent";
import { executeCommand, isCommand, registerCommand } from "../commands";
import { createClearCommand } from "../commands/clear";
import { createModelCommand } from "../commands/model";
import { createRenderCommand } from "../commands/render";
import { createThinkCommand } from "../commands/think";
import { createToolFallbackCommand } from "../commands/tool-fallback";
import { MessageHistory } from "../context/message-history";
import { initializeSession } from "../context/session";
import { env } from "../env";
import { colorize } from "../interaction/colors";
import { renderFullStream } from "../interaction/stream-renderer";
import { askBatchApproval } from "../interaction/tool-approval";
import { cleanupSession } from "../tools/execute/shared-tmux-session";

// Bracketed paste mode escape sequences
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Enable/disable bracketed paste mode
const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
// Regex patterns for line ending normalization
const LINE_ENDING_REGEX = /\r\n|\r|\n/g;
const LAST_LINE_REGEX = /[^\r\n]*$/;

const messageHistory = new MessageHistory();

let rlInstance: ReadlineInterface | null = null;
let shouldExit = false;

process.on("exit", () => {
  if (env.DEBUG_TMUX_CLEANUP) {
    console.error("[DEBUG] Process exit handler called");
  }
  cleanupSession();
});

registerCommand(
  createRenderCommand(async () => ({
    model: agentManager.getModelId(),
    modelType: agentManager.getModelType(),
    instructions: await agentManager.getInstructions(),
    tools: agentManager.getTools(),
    messages: messageHistory.toModelMessages(),
    thinkingEnabled: agentManager.isThinkingEnabled(),
    toolFallbackEnabled: agentManager.isToolFallbackEnabled(),
  }))
);
registerCommand(createModelCommand());
registerCommand(createClearCommand(messageHistory));
registerCommand(createThinkCommand());
registerCommand(createToolFallbackCommand());

const processAgentResponse = async (rl: ReadlineInterface): Promise<void> => {
  const stream = await agentManager.stream(messageHistory.toModelMessages());
  const { approvalRequests } = await renderFullStream(stream.fullStream, {
    showSteps: false,
  });

  const response = await stream.response;
  messageHistory.addModelMessages(response.messages);

  if (approvalRequests.length > 0) {
    const approvals = await askBatchApproval(rl, approvalRequests);
    messageHistory.addToolApprovalResponses(approvals);
    await processAgentResponse(rl);
  }
};

const parseCliArgs = (): { thinking: boolean; toolFallback: boolean } => {
  const args = process.argv.slice(2);
  let thinking = false;
  let toolFallback = false;

  for (const arg of args) {
    if (arg === "--think") {
      thinking = true;
    } else if (arg === "--tool-fallback") {
      toolFallback = true;
    }
  }

  return { thinking, toolFallback };
};

const handleGracefulShutdown = () => {
  shouldExit = true;
  console.log("\nShutting down...");

  if (rlInstance) {
    rlInstance.close();
  }

  cleanupSession();
  process.exit(0);
};

const shouldExitFromInput = (input: string): boolean => {
  return shouldExit || input.length === 0 || input.toLowerCase() === "exit";
};

const handleCommandExecution = async (command: string): Promise<void> => {
  try {
    const result = await executeCommand(command);
    if (result?.message) {
      console.log(result.message);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`Command error: ${errorMessage}`);
  }
};

const handleAgentResponse = async (rl: ReadlineInterface): Promise<void> => {
  try {
    await processAgentResponse(rl);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\nError: ${errorMessage}`);
    console.error("Returning to prompt...\n");
  }
};

// Control character codes
const CTRL_C = 3;
const CTRL_D = 4;
const TAB = 9;
const LF = 10;
const CR = 13;
const BACKSPACE_1 = 8;
const BACKSPACE_2 = 127;

interface InputState {
  buffer: string;
  isPasting: boolean;
  rawBuffer: string;
}

type InputAction = "submit" | "cancel" | "continue";

const isBackspace = (code: number): boolean =>
  code === BACKSPACE_1 || code === BACKSPACE_2;

const isEnter = (code: number): boolean => code === CR || code === LF;

const isAllowedControlChar = (code: number): boolean => code === TAB;

const handleBackspace = (state: InputState): void => {
  if (state.buffer.length > 0) {
    const chars = [...state.buffer];
    chars.pop();
    state.buffer = chars.join("");
    process.stdout.write("\b \b");
  }
};

const processCharacter = (
  char: string,
  state: InputState
): InputAction | null => {
  const code = char.charCodeAt(0);

  if (code === CTRL_C) {
    return "cancel";
  }
  if (code === CTRL_D) {
    return state.buffer.length === 0 ? "cancel" : "submit";
  }
  if (isEnter(code)) {
    return "submit";
  }

  if (isBackspace(code)) {
    handleBackspace(state);
    return null;
  }

  // Ignore non-allowed control characters
  if (code < 32 && !isAllowedControlChar(code)) {
    return null;
  }

  // Regular character
  state.buffer += char;
  process.stdout.write(char);
  return null;
};

const processPasteSequences = (state: InputState): boolean => {
  const pasteStartIdx = state.rawBuffer.indexOf(PASTE_START);
  if (pasteStartIdx !== -1) {
    state.isPasting = true;
    state.rawBuffer = state.rawBuffer.slice(pasteStartIdx + PASTE_START.length);
  }

  const pasteEndIdx = state.rawBuffer.indexOf(PASTE_END);
  if (pasteEndIdx !== -1) {
    const pastedContent = state.rawBuffer.slice(0, pasteEndIdx);
    state.buffer += pastedContent;

    // Normalize all line endings to \r\n for raw mode display
    const displayContent = pastedContent.replace(LINE_ENDING_REGEX, "\r\n");
    process.stdout.write(displayContent);

    // Ensure cursor is at end of last line by rewriting it
    const lastLineMatch = pastedContent.match(LAST_LINE_REGEX);
    if (lastLineMatch && lastLineMatch[0].length > 0) {
      process.stdout.write(`\r${lastLineMatch[0]}`);
    }

    state.rawBuffer = state.rawBuffer.slice(pasteEndIdx + PASTE_END.length);
    state.isPasting = false;
    return true; // Paste completed
  }

  return false;
};

/**
 * Collects user input with support for multi-line pastes using bracketed paste mode.
 * - When text is pasted, newlines within the paste are preserved in the buffer
 * - Input is only submitted when Enter is pressed outside of a paste operation
 * - Supports basic line editing (backspace, Ctrl+C, Ctrl+D)
 */
const collectMultilineInput = (
  rl: ReadlineInterface,
  prompt: string
): Promise<string | null> => {
  return new Promise((resolve) => {
    const state: InputState = {
      buffer: "",
      isPasting: false,
      rawBuffer: "",
    };

    // Store and remove existing stdin listeners to prevent double processing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingListeners = process.stdin.listeners("data") as Array<
      (...args: unknown[]) => void
    >;
    for (const listener of existingListeners) {
      process.stdin.removeListener("data", listener);
    }

    // Pause readline
    rl.pause();

    const enableRawMode = () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdout.write(ENABLE_BRACKETED_PASTE);
    };

    const disableRawMode = () => {
      process.stdout.write(DISABLE_BRACKETED_PASTE);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      disableRawMode();
      // Restore previous stdin listeners
      for (const listener of existingListeners) {
        process.stdin.on("data", listener);
      }
    };

    const finalize = (result: string | null) => {
      cleanup();
      rl.resume(); // Resume readline for tool approval prompts
      process.stdout.write("\n");
      resolve(result);
    };

    const onData = (data: Buffer) => {
      state.rawBuffer += data.toString();

      // Process all content in rawBuffer
      while (state.rawBuffer.length > 0) {
        // Check for paste sequences first
        const pasteHandled = processPasteSequences(state);

        if (state.isPasting) {
          return; // Wait for paste end sequence
        }

        if (pasteHandled) {
          continue; // Paste was handled, continue processing remaining buffer
        }

        // No paste sequence, process one character at a time
        const char = state.rawBuffer[0];
        state.rawBuffer = state.rawBuffer.slice(1);

        const action = processCharacter(char, state);
        if (action === "submit") {
          finalize(state.buffer);
          return;
        }
        if (action === "cancel") {
          finalize(null);
          return;
        }
      }
    };

    enableRawMode();
    process.stdout.write(prompt);
    process.stdin.on("data", onData);
  });
};

const run = async (): Promise<void> => {
  const sessionId = initializeSession();
  console.log(colorize("dim", `Session: ${sessionId}\n`));

  const { thinking, toolFallback } = parseCliArgs();
  agentManager.setThinkingEnabled(thinking);
  agentManager.setToolFallbackEnabled(toolFallback);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rlInstance = rl;
  process.on("SIGINT", handleGracefulShutdown);

  try {
    while (!shouldExit) {
      const input = await collectMultilineInput(
        rl,
        `${colorize("blue", "You")}: `
      );

      if (input === null) {
        break;
      }

      const trimmed = input.trim();

      if (shouldExitFromInput(trimmed)) {
        break;
      }

      if (isCommand(trimmed)) {
        await handleCommandExecution(trimmed);
        continue;
      }

      messageHistory.addUserMessage(trimmed);
      await handleAgentResponse(rl);
    }
  } catch (error) {
    console.error("Error:", error);
    throw error;
  } finally {
    if (env.DEBUG_TMUX_CLEANUP) {
      console.error("[DEBUG] Performing cleanup...");
    }
    process.off("SIGINT", handleGracefulShutdown);
    rlInstance = null;
    rl.close();
    cleanupSession();
    if (env.DEBUG_TMUX_CLEANUP) {
      console.error("[DEBUG] Cleanup completed.");
    }
  }
};

run().catch((error: unknown) => {
  throw error instanceof Error ? error : new Error("Failed to run stream.");
});
