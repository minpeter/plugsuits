#!/usr/bin/env bun

import type { Interface as ReadlineInterface } from "node:readline";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import type { ProviderType } from "../agent";
import { agentManager } from "../agent";
import {
  executeCommand,
  getCommands,
  isCommand,
  isSkillCommandResult,
  registerCommand,
} from "../commands";
import { createClearCommand } from "../commands/clear";
import { createModelCommand } from "../commands/model";
import { createRenderCommand } from "../commands/render";
import { createThinkCommand } from "../commands/think";
import { createToolFallbackCommand } from "../commands/tool-fallback";
import { MessageHistory } from "../context/message-history";
import { initializeSession } from "../context/session";
import type { SkillInfo } from "../context/skills";
import { loadAllSkills } from "../context/skills";
import { env } from "../env";
import { colorize } from "../interaction/colors";
import { StdinBuffer } from "../interaction/stdin-buffer";
import { renderFullStream } from "../interaction/stream-renderer";
import { askBatchApproval } from "../interaction/tool-approval";
import {
  buildTodoContinuationUserMessage,
  getIncompleteTodos,
} from "../middleware/todo-continuation";
import { cleanupSession } from "../tools/execute/shared-tmux-session";
import { initializeTools } from "../utils/tools-manager";

// Bracketed paste mode escape sequences
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Enable/disable bracketed paste mode
const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
// Regex patterns for line ending normalization
const LINE_ENDING_REGEX = /\r\n|\r|\n/g;

// ANSI escape codes for styling
const ANSI_DIM = "\x1b[90m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_RESET = "\x1b[0m";
const ANSI_CURSOR_UP = (n: number) => `\x1b[${n}A`;
const ANSI_CURSOR_FORWARD = (n: number) => `\x1b[${n}C`;
const ANSI_CLEAR_TO_END = "\x1b[J";
const ANSI_CLEAR_LINE = "\x1b[2K"; // Clear entire line

const messageHistory = new MessageHistory();

let rlInstance: ReadlineInterface | null = null;
let shouldExit = false;
let cachedSkills: SkillInfo[] = [];
const commandHistory: string[] = []; // Store command history
const historyIndex = -1; // Current position in history (-1 = not browsing)

const TODO_CONTINUATION_MAX_LOOPS = 5;

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

const parseCliArgs = (): {
  thinking: boolean;
  toolFallback: boolean;
  model: string | null;
  provider: ProviderType | null;
} => {
  const args = process.argv.slice(2);
  let thinking = false;
  let toolFallback = false;
  let model: string | null = null;
  let provider: ProviderType | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--think") {
      thinking = true;
    } else if (arg === "--tool-fallback") {
      toolFallback = true;
    } else if (arg === "--model" && i + 1 < args.length) {
      model = args[i + 1];
      i++;
    } else if (arg === "--provider" && i + 1 < args.length) {
      const providerArg = args[i + 1];
      if (providerArg === "anthropic" || providerArg === "friendli") {
        provider = providerArg;
      }
      i++;
    }
  }

  return { thinking, toolFallback, model, provider };
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

const handleAgentResponse = async (rl: ReadlineInterface): Promise<void> => {
  try {
    let continuationCount = 0;

    while (continuationCount <= TODO_CONTINUATION_MAX_LOOPS) {
      await processAgentResponse(rl);

      const incompleteTodos = await getIncompleteTodos();
      if (incompleteTodos.length === 0) {
        return;
      }

      if (continuationCount === TODO_CONTINUATION_MAX_LOOPS) {
        console.log(
          colorize(
            "yellow",
            "[todo] Auto-continue limit reached; waiting for input."
          )
        );
        return;
      }

      const reminder = buildTodoContinuationUserMessage(incompleteTodos);
      messageHistory.addUserMessage(reminder);
      continuationCount += 1;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\nError: ${errorMessage}`);
    console.error("Returning to prompt...\n");
  }
};

// Control character codes
const CTRL_A = 1;
const CTRL_B = 2;
const CTRL_C = 3;
const CTRL_D = 4;
const CTRL_E = 5;
const CTRL_F = 6;
const TAB = 9;
const LF = 10;
const CTRL_K = 11;
const CTRL_U = 21;
const CTRL_W = 23;
const CR = 13;
const BACKSPACE_1 = 8;
const BACKSPACE_2 = 127;

const WHITESPACE_REGEX = /\s/;
const ZERO_WIDTH_CODEPOINTS = new Set([0x20_0d, 0xfe_0e, 0xfe_0f]);

const stripVtControlCharacters =
  typeof stripVTControlCharacters === "function"
    ? stripVTControlCharacters
    : null;

// Try to get getStringWidth from node:util if available
// This is an experimental feature, so we check for it at runtime
let getNodeStringWidth: ((str: string) => number) | null = null;
try {
  const nodeUtil = require("node:util");
  if (typeof nodeUtil.getStringWidth === "function") {
    getNodeStringWidth = nodeUtil.getStringWidth;
  }
} catch {
  // getStringWidth not available
}

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

interface Suggestion {
  value: string;
  description: string;
}

interface InputState {
  buffer: string;
  cursor: number;
  suggestions: Suggestion[];
  suggestionIndex: number;
  lastSuggestionRows: number; // Track suggestion area for clean repainting
  historyIndex: number; // Current position in command history (-1 = not browsing)
  originalBuffer: string; // Save current input when browsing history
}

type InputAction = "submit" | "cancel" | "continue";

type EscapeAction =
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "delete"
  | "word-left"
  | "word-right"
  | "delete-word-left"
  | "delete-word-right"
  | "line-start"
  | "line-end";

type InputToken =
  | { type: "text"; value: string; length: number }
  | { type: "escape"; action: EscapeAction; length: number }
  | { type: "paste-start"; length: number }
  | { type: "paste-end"; length: number }
  | { type: "ignore"; length: number };

const stripAnsi = (input: string): string => {
  let output = "";
  let idx = 0;

  while (idx < input.length) {
    const char = input[idx];
    if (char === "\u001b" || char === "\u009b") {
      if (char === "\u001b" && input[idx + 1] === "[") {
        idx += 2;
      } else {
        idx += 1;
      }

      while (idx < input.length) {
        const code = input.charCodeAt(idx);
        idx += 1;
        if (code >= 0x40 && code <= 0x7e) {
          break;
        }
      }
      continue;
    }

    output += char;
    idx += 1;
  }

  return output;
};

const splitGraphemes = (input: string): string[] => {
  if (!graphemeSegmenter) {
    return Array.from(input);
  }
  return Array.from(
    graphemeSegmenter.segment(input),
    (segment) => segment.segment
  );
};

const normalizeLineEndings = (input: string): string =>
  input.replace(LINE_ENDING_REGEX, "\n");

const isCombiningCodePoint = (codePoint: number): boolean =>
  (codePoint >= 0x03_00 && codePoint <= 0x03_6f) ||
  (codePoint >= 0x1a_b0 && codePoint <= 0x1a_ff) ||
  (codePoint >= 0x1d_c0 && codePoint <= 0x1d_ff) ||
  (codePoint >= 0x20_d0 && codePoint <= 0x20_ff) ||
  (codePoint >= 0xfe_20 && codePoint <= 0xfe_2f);

const isFullwidthCodePoint = (codePoint: number): boolean =>
  codePoint >= 0x11_00 &&
  (codePoint <= 0x11_5f ||
    codePoint === 0x23_29 ||
    codePoint === 0x23_2a ||
    (codePoint >= 0x2e_80 && codePoint <= 0xa4_cf && codePoint !== 0x30_3f) ||
    (codePoint >= 0xac_00 && codePoint <= 0xd7_a3) ||
    (codePoint >= 0xf9_00 && codePoint <= 0xfa_ff) ||
    (codePoint >= 0xfe_10 && codePoint <= 0xfe_19) ||
    (codePoint >= 0xfe_30 && codePoint <= 0xfe_6f) ||
    (codePoint >= 0xff_00 && codePoint <= 0xff_60) ||
    (codePoint >= 0xff_e0 && codePoint <= 0xff_e6) ||
    (codePoint >= 0x1_f3_00 && codePoint <= 0x1_f6_4f) ||
    (codePoint >= 0x1_f9_00 && codePoint <= 0x1_f9_ff) ||
    (codePoint >= 0x2_00_00 && codePoint <= 0x3_ff_fd));

const getCodePointWidth = (char: string): number => {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
    return 0;
  }
  if (ZERO_WIDTH_CODEPOINTS.has(codePoint)) {
    return 0;
  }
  if (isCombiningCodePoint(codePoint)) {
    return 0;
  }
  if (isFullwidthCodePoint(codePoint)) {
    return 2;
  }
  return 1;
};

const getStringWidthFallback = (input: string): number => {
  let width = 0;
  for (const char of input) {
    width += getCodePointWidth(char);
  }
  return width;
};

const getStringWidth = (input: string): number => {
  const sanitized = stripVtControlCharacters
    ? stripVtControlCharacters(input)
    : input;
  if (getNodeStringWidth) {
    return getNodeStringWidth(sanitized);
  }
  return getStringWidthFallback(sanitized);
};

const isWhitespace = (value: string): boolean => WHITESPACE_REGEX.test(value);

const findLineStart = (graphemes: string[], cursor: number): number => {
  for (let i = cursor - 1; i >= 0; i -= 1) {
    if (graphemes[i] === "\n") {
      return i + 1;
    }
  }
  return 0;
};

const findLineEnd = (graphemes: string[], cursor: number): number => {
  for (let i = cursor; i < graphemes.length; i += 1) {
    if (graphemes[i] === "\n") {
      return i;
    }
  }
  return graphemes.length;
};

const advancePosition = (
  text: string,
  start: { row: number; col: number },
  columns: number
): { row: number; col: number } => {
  let row = start.row;
  let col = start.col;
  const safeColumns = columns > 0 ? columns : 80;

  for (const segment of splitGraphemes(text)) {
    if (segment === "\n") {
      row += 1;
      col = 0;
      continue;
    }

    const width = getStringWidth(segment);
    if (width === 0) {
      continue;
    }

    if (col + width > safeColumns) {
      row += 1;
      col = 0;
    }

    col += width;
    if (col >= safeColumns) {
      row += 1;
      col = 0;
    }
  }

  return { row, col };
};

const calculateDisplayMetrics = (
  promptPlain: string,
  buffer: string,
  cursor: number,
  columns: number
): {
  totalRows: number;
  cursorPos: { row: number; col: number };
  endPos: { row: number; col: number };
} => {
  const promptPos = advancePosition(promptPlain, { row: 0, col: 0 }, columns);
  const graphemes = splitGraphemes(buffer);
  const beforeCursor = graphemes.slice(0, cursor).join("");
  const cursorPos = advancePosition(beforeCursor, promptPos, columns);
  const endPos = advancePosition(buffer, promptPos, columns);
  const totalRows = Math.max(1, endPos.row + 1);

  return { totalRows, cursorPos, endPos };
};

const MAX_VISIBLE_SUGGESTIONS = 8;
const MIN_DESCRIPTION_LENGTH = 20;
const SUGGESTION_PADDING = 10;

/**
 * Create a suggestion object for a command argument.
 */
const createArgumentSuggestion = (
  commandName: string,
  arg: string
): Suggestion => ({
  value: `/${commandName} ${arg}`,
  description: `Argument: ${arg}`,
});

/**
 * Determine if the suggestion list should be displayed.
 */
const shouldDisplaySuggestionList = (
  state: InputState,
  cursorAtEnd: boolean
): boolean => {
  if (state.suggestions.length === 0) {
    return false;
  }
  if (!cursorAtEnd) {
    return false;
  }
  if (state.buffer.length === 0) {
    return false;
  }
  // Hide list when the only suggestion exactly matches the buffer
  const isFullyTyped =
    state.suggestions.length === 1 &&
    state.suggestions[0].value === state.buffer;
  return !isFullyTyped;
};

/**
 * Calculate the maximum description length based on terminal width.
 * Returns a safe minimum even for very small terminals.
 */
const calculateMaxDescriptionLength = (
  columns: number,
  valueLength: number
): number => {
  const available = columns - valueLength - SUGGESTION_PADDING;
  return Math.max(MIN_DESCRIPTION_LENGTH, available);
};

/**
 * Truncate description to fit within the given max length.
 */
const truncateDescription = (description: string, maxLen: number): string => {
  if (description.length <= maxLen) {
    return description;
  }
  return `${description.slice(0, maxLen - 3)}...`;
};

/**
 * Calculate the scroll window for suggestion list display.
 */
const calculateScrollWindow = (
  total: number,
  selectedIndex: number,
  maxVisible: number
): { startIndex: number; endIndex: number } => {
  let startIndex = 0;
  if (total > maxVisible) {
    const scrollPadding = Math.floor(maxVisible / 2);
    startIndex = Math.max(0, selectedIndex - scrollPadding);
    startIndex = Math.min(startIndex, total - maxVisible);
  }
  return { startIndex, endIndex: startIndex + maxVisible };
};

/**
 * Render a single suggestion item.
 */
const renderSuggestionItem = (
  suggestion: Suggestion,
  isSelected: boolean,
  columns: number
): void => {
  const prefix = isSelected ? `${ANSI_CYAN}› ` : "  ";
  const reset = isSelected ? ANSI_RESET : "";
  const maxDescLen = calculateMaxDescriptionLength(
    columns,
    suggestion.value.length
  );
  const desc = truncateDescription(suggestion.description, maxDescLen);
  process.stdout.write(
    `${prefix}${suggestion.value}${ANSI_DIM} - ${desc}${ANSI_RESET}${reset}\n`
  );
};

/**
 * Render the suggestion list below the input.
 * Returns the number of rows rendered.
 */
const renderSuggestionList = (state: InputState, columns: number): number => {
  const total = state.suggestions.length;
  const maxVisible = Math.min(MAX_VISIBLE_SUGGESTIONS, total);
  const { startIndex, endIndex } = calculateScrollWindow(
    total,
    state.suggestionIndex,
    maxVisible
  );

  process.stdout.write("\n");
  let rows = 1;

  // Show scroll indicator at top if not at beginning
  if (startIndex > 0) {
    process.stdout.write(
      `${ANSI_DIM}  ↑ ${startIndex} more above${ANSI_RESET}\n`
    );
    rows++;
  }

  // Render visible suggestions
  for (let i = startIndex; i < endIndex; i++) {
    renderSuggestionItem(
      state.suggestions[i],
      i === state.suggestionIndex,
      columns
    );
    rows++;
  }

  // Show scroll indicator at bottom if not at end
  if (endIndex < total) {
    const remaining = total - endIndex;
    process.stdout.write(
      `${ANSI_DIM}  ↓ ${remaining} more below${ANSI_RESET}\n`
    );
    rows++;
  }

  return rows;
};

const renderInput = (
  state: InputState,
  prompt: string,
  promptPlain: string
): void => {
  const columns = process.stdout.columns || 80;

  // Get inline suggestion hint if available
  let suggestionText = "";
  const cursorAtEnd = state.cursor === splitGraphemes(state.buffer).length;

  if (
    state.suggestions.length > 0 &&
    state.suggestionIndex < state.suggestions.length &&
    cursorAtEnd
  ) {
    const suggestion = state.suggestions[state.suggestionIndex];
    if (suggestion.value.toLowerCase().startsWith(state.buffer.toLowerCase())) {
      suggestionText = suggestion.value.slice(state.buffer.length);
    }
  }

  // Clear current line and rewrite (like spinner.ts does)
  process.stdout.write("\r\x1B[K");

  // Write prompt and buffer (single line only - no multiline rendering)
  const displayBuffer = state.buffer.replace(/\n/g, " "); // Replace newlines with spaces for single-line display
  process.stdout.write(`${prompt}${displayBuffer}`);

  // Write inline suggestion in gray
  if (suggestionText.length > 0) {
    process.stdout.write(`${ANSI_DIM}${suggestionText}${ANSI_RESET}`);
  }

  // Clear old suggestion area if it exists (move down and clear)
  if (state.lastSuggestionRows > 0) {
    for (let i = 0; i < state.lastSuggestionRows; i++) {
      process.stdout.write("\n\r\x1B[K"); // Move down one line and clear it
    }
    // Move back to input line
    process.stdout.write(ANSI_CURSOR_UP(state.lastSuggestionRows));
    process.stdout.write("\r");
  }

  // Render new suggestion list (renderSuggestionList will handle \n and positioning)
  const shouldShowList = shouldDisplaySuggestionList(state, cursorAtEnd);
  if (shouldShowList) {
    const suggestionRows = renderSuggestionList(state, columns);
    state.lastSuggestionRows = suggestionRows;
    // renderSuggestionList already moved us down, move back to input line
    process.stdout.write(ANSI_CURSOR_UP(suggestionRows));
    process.stdout.write("\r");
  } else {
    state.lastSuggestionRows = 0;
  }

  // Calculate cursor position within the line
  const graphemes = splitGraphemes(displayBuffer);
  const beforeCursor = graphemes.slice(0, state.cursor).join("");
  const cursorCol = getStringWidth(promptPlain) + getStringWidth(beforeCursor);

  // Move cursor to correct position using absolute positioning
  process.stdout.write("\r");
  if (cursorCol > 0) {
    process.stdout.write(ANSI_CURSOR_FORWARD(cursorCol));
  }
};

const insertText = (state: InputState, text: string): void => {
  if (text.length === 0) {
    return;
  }
  const graphemes = splitGraphemes(state.buffer);
  const insertGraphemes = splitGraphemes(text);
  graphemes.splice(state.cursor, 0, ...insertGraphemes);
  state.cursor += insertGraphemes.length;
  state.buffer = graphemes.join("");
};

const deleteBackward = (state: InputState): void => {
  if (state.cursor === 0) {
    return;
  }
  const graphemes = splitGraphemes(state.buffer);
  graphemes.splice(state.cursor - 1, 1);
  state.cursor -= 1;
  state.buffer = graphemes.join("");
};

const deleteForward = (state: InputState): void => {
  const graphemes = splitGraphemes(state.buffer);
  if (state.cursor >= graphemes.length) {
    return;
  }
  graphemes.splice(state.cursor, 1);
  state.buffer = graphemes.join("");
};

const moveCursorLeft = (state: InputState): void => {
  if (state.cursor > 0) {
    state.cursor -= 1;
  }
};

const moveCursorRight = (state: InputState): void => {
  const graphemes = splitGraphemes(state.buffer);
  if (state.cursor < graphemes.length) {
    state.cursor += 1;
  }
};

const moveWordLeft = (state: InputState): void => {
  const graphemes = splitGraphemes(state.buffer);
  let idx = state.cursor;
  while (idx > 0 && isWhitespace(graphemes[idx - 1])) {
    idx -= 1;
  }
  while (idx > 0 && !isWhitespace(graphemes[idx - 1])) {
    idx -= 1;
  }
  state.cursor = idx;
};

const moveWordRight = (state: InputState): void => {
  const graphemes = splitGraphemes(state.buffer);
  let idx = state.cursor;
  while (idx < graphemes.length && isWhitespace(graphemes[idx])) {
    idx += 1;
  }
  while (idx < graphemes.length && !isWhitespace(graphemes[idx])) {
    idx += 1;
  }
  state.cursor = idx;
};

const deleteWordLeft = (state: InputState): void => {
  const graphemes = splitGraphemes(state.buffer);
  let idx = state.cursor;
  while (idx > 0 && isWhitespace(graphemes[idx - 1])) {
    idx -= 1;
  }
  while (idx > 0 && !isWhitespace(graphemes[idx - 1])) {
    idx -= 1;
  }
  graphemes.splice(idx, state.cursor - idx);
  state.cursor = idx;
  state.buffer = graphemes.join("");
};

const deleteWordRight = (state: InputState): void => {
  const graphemes = splitGraphemes(state.buffer);
  let idx = state.cursor;
  while (idx < graphemes.length && isWhitespace(graphemes[idx])) {
    idx += 1;
  }
  while (idx < graphemes.length && !isWhitespace(graphemes[idx])) {
    idx += 1;
  }
  graphemes.splice(state.cursor, idx - state.cursor);
  state.buffer = graphemes.join("");
};

const moveLineStart = (state: InputState): void => {
  const graphemes = splitGraphemes(state.buffer);
  state.cursor = findLineStart(graphemes, state.cursor);
};

const moveLineEnd = (state: InputState): void => {
  const graphemes = splitGraphemes(state.buffer);
  state.cursor = findLineEnd(graphemes, state.cursor);
};

const deleteToLineStart = (state: InputState): void => {
  const graphemes = splitGraphemes(state.buffer);
  const lineStart = findLineStart(graphemes, state.cursor);
  graphemes.splice(lineStart, state.cursor - lineStart);
  state.cursor = lineStart;
  state.buffer = graphemes.join("");
};

const deleteToLineEnd = (state: InputState): void => {
  const graphemes = splitGraphemes(state.buffer);
  const lineEnd = findLineEnd(graphemes, state.cursor);
  graphemes.splice(state.cursor, lineEnd - state.cursor);
  state.buffer = graphemes.join("");
};

const createEscapeToken = (
  action: EscapeAction,
  length: number
): InputToken => ({
  type: "escape",
  action,
  length,
});

const parsePasteToken = (rawBuffer: string): InputToken | null => {
  if (rawBuffer.startsWith(PASTE_START)) {
    return { type: "paste-start", length: PASTE_START.length };
  }
  if (rawBuffer.startsWith(PASTE_END)) {
    return { type: "paste-end", length: PASTE_END.length };
  }
  return null;
};

const parseCsiNumbers = (params: string): number[] => {
  if (!params) {
    return [];
  }
  return params
    .split(";")
    .map((value) => Number.parseInt(value.replace("?", ""), 10))
    .filter((value) => Number.isFinite(value));
};

const parseCsiAction = (
  final: string,
  numbers: number[]
): EscapeAction | null => {
  const hasModifier = (value: number): boolean => numbers.includes(value);
  const actionForDirection = (direction: "left" | "right"): EscapeAction => {
    if (hasModifier(9)) {
      return direction === "left" ? "line-start" : "line-end";
    }
    if (hasModifier(3) || hasModifier(5)) {
      return direction === "left" ? "word-left" : "word-right";
    }
    return direction;
  };

  if (final === "D") {
    return actionForDirection("left");
  }
  if (final === "C") {
    return actionForDirection("right");
  }
  if (final === "A") {
    return "up";
  }
  if (final === "B") {
    return "down";
  }
  if (final === "H") {
    return "home";
  }
  if (final === "F") {
    return "end";
  }
  if (final === "~") {
    const code = numbers[0];
    if (code === 3) {
      return "delete";
    }
    if (code === 1 || code === 7) {
      return "home";
    }
    if (code === 4 || code === 8) {
      return "end";
    }
  }
  return null;
};

const parseCsiToken = (rawBuffer: string): InputToken | null => {
  if (rawBuffer.length < 3) {
    return null;
  }

  let params = "";
  let idx = 2;

  while (idx < rawBuffer.length) {
    const code = rawBuffer.charCodeAt(idx);
    if (code >= 0x40 && code <= 0x7e) {
      const final = rawBuffer[idx];
      const numbers = parseCsiNumbers(params);
      const action = parseCsiAction(final, numbers);
      const length = idx + 1;
      return action
        ? createEscapeToken(action, length)
        : { type: "ignore", length };
    }

    params += rawBuffer[idx];
    idx += 1;
  }

  return null;
};

const parseSs3Token = (rawBuffer: string): InputToken | null => {
  if (rawBuffer.length < 3) {
    return null;
  }
  const third = rawBuffer[2];
  if (third === "D") {
    return createEscapeToken("left", 3);
  }
  if (third === "C") {
    return createEscapeToken("right", 3);
  }
  if (third === "H") {
    return createEscapeToken("home", 3);
  }
  if (third === "F") {
    return createEscapeToken("end", 3);
  }
  return { type: "ignore", length: 3 };
};

const parseAltToken = (rawBuffer: string): InputToken | null => {
  if (rawBuffer.length < 2) {
    return null;
  }
  const next = rawBuffer[1];
  if (next === "b") {
    return createEscapeToken("word-left", 2);
  }
  if (next === "f") {
    return createEscapeToken("word-right", 2);
  }
  if (next === "d") {
    return createEscapeToken("delete-word-right", 2);
  }
  if (next === "\u007f" || next === "\b") {
    return createEscapeToken("delete-word-left", 2);
  }
  return null;
};

const readEscapeToken = (rawBuffer: string): InputToken | null => {
  const pasteToken = parsePasteToken(rawBuffer);
  if (pasteToken) {
    return pasteToken;
  }

  if (rawBuffer.length < 2) {
    return null;
  }

  const second = rawBuffer[1];
  if (second === "[") {
    return parseCsiToken(rawBuffer);
  }
  if (second === "O") {
    return parseSs3Token(rawBuffer);
  }

  const altToken = parseAltToken(rawBuffer);
  if (altToken) {
    return altToken;
  }

  return { type: "ignore", length: 1 };
};

const readEscapeTokenFromSequence = (sequence: string): InputToken | null => {
  const token = readEscapeToken(sequence);
  if (!token) {
    return null;
  }
  if (token.type === "ignore") {
    return { type: "ignore", length: sequence.length };
  }
  if (token.type === "paste-start" || token.type === "paste-end") {
    return { type: "ignore", length: sequence.length };
  }
  return token;
};

/**
 * Get command suggestions based on the current input buffer.
 * Returns an array of Suggestion objects with value and description.
 * Also includes available skills.
 */
const getCommandSuggestions = (buffer: string): Suggestion[] => {
  if (!buffer.startsWith("/")) {
    return [];
  }

  const commandMap = getCommands();

  // Check if buffer contains a space (command + argument)
  const spaceIndex = buffer.indexOf(" ");

  if (spaceIndex === -1) {
    // No space: suggest command names and skills
    const suggestions: Suggestion[] = [];

    // Add built-in commands
    for (const [name, cmd] of commandMap) {
      suggestions.push({
        value: `/${name}`,
        description: cmd.description,
      });
    }

    // Add skills (avoid duplicates)
    const commandNames = new Set(commandMap.keys());
    for (const skill of cachedSkills) {
      if (!commandNames.has(skill.id)) {
        suggestions.push({
          value: `/${skill.id}`,
          description: skill.description,
        });
      }
    }

    // If the buffer is exactly "/", return all
    if (buffer === "/") {
      return suggestions.sort((a, b) => a.value.localeCompare(b.value));
    }

    // Filter by prefix match
    const matches = suggestions.filter((s) =>
      s.value.toLowerCase().startsWith(buffer.toLowerCase())
    );

    return matches.sort((a, b) => a.value.localeCompare(b.value));
  }

  // Space found: suggest arguments
  const commandName = buffer.slice(1, spaceIndex);
  const argPart = buffer.slice(spaceIndex + 1);

  const command = commandMap.get(commandName);
  if (!command?.argumentSuggestions) {
    return [];
  }

  // If no argument typed yet, return all suggestions with full command prefix
  if (argPart === "") {
    return command.argumentSuggestions.map((arg) =>
      createArgumentSuggestion(commandName, arg)
    );
  }

  // Check if argPart exactly matches one of the suggestions
  const exactMatch = command.argumentSuggestions.some(
    (arg) => arg.toLowerCase() === argPart.toLowerCase()
  );

  // If exact match, return all suggestions for cycling
  if (exactMatch) {
    return command.argumentSuggestions.map((arg) =>
      createArgumentSuggestion(commandName, arg)
    );
  }

  // Filter argument suggestions that start with the typed argument
  const matches = command.argumentSuggestions.filter((arg) =>
    arg.toLowerCase().startsWith(argPart.toLowerCase())
  );

  return matches.map((arg) => createArgumentSuggestion(commandName, arg));
};

/**
 * Update suggestions based on the current buffer.
 */
const updateSuggestions = (state: InputState): void => {
  state.suggestions = getCommandSuggestions(state.buffer);
  state.suggestionIndex = 0;
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
  // Non-TTY fallback: read input using readline events for piped input
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      process.stdout.write(prompt);
      let allInput = "";
      const onLine = (line: string) => {
        allInput += `${line}\n`;
      };
      const onClose = () => {
        rl.removeListener("line", onLine);
        rl.removeListener("close", onClose);
        resolve(allInput.length > 0 ? allInput.trim() : null);
      };
      rl.on("line", onLine);
      rl.on("close", onClose);
    });
  }

  return new Promise((resolve) => {
    const state: InputState = {
      buffer: "",
      cursor: 0,
      suggestions: [],
      suggestionIndex: 0,
      lastSuggestionRows: 0,
      historyIndex: -1,
      originalBuffer: "",
    };
    const utf8Decoder = new TextDecoder("utf-8");
    const promptPlain = stripAnsi(prompt);
    const stdinBuffer = new StdinBuffer();

    // Store and remove existing stdin listeners to prevent double processing
    const existingListeners = process.stdin.listeners("data") as ((
      chunk: Buffer
    ) => void)[];
    for (const listener of existingListeners) {
      process.stdin.removeListener("data", listener);
    }

    // Pause readline
    rl.pause();

    const enableRawMode = () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdout.write(ENABLE_BRACKETED_PASTE);
      }
      process.stdin.resume();
    };

    const disableRawMode = () => {
      if (process.stdin.isTTY) {
        process.stdout.write(DISABLE_BRACKETED_PASTE);
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
      // Clear inline suggestion and suggestion list, but keep the actual input
      // ANSI_CLEAR_TO_END clears from cursor to end of screen (removes inline hint + suggestion list)
      process.stdout.write(ANSI_CLEAR_TO_END);
      process.stdout.write("\n");
      resolve(result);
    };

    const render = () => {
      renderInput(state, prompt, promptPlain);
    };

    const applyAndRender = (action: () => void): InputAction | null => {
      action();
      updateSuggestions(state);
      render();
      return null;
    };

    const applyEscapeAction = (action: EscapeAction): void => {
      switch (action) {
        case "left":
          moveCursorLeft(state);
          break;
        case "right":
          moveCursorRight(state);
          break;
        case "up":
          if (state.suggestions.length > 0) {
            // Navigate suggestions if available
            state.suggestionIndex =
              state.suggestionIndex > 0
                ? state.suggestionIndex - 1
                : state.suggestions.length - 1;
          } else if (commandHistory.length > 0) {
            // Navigate command history
            if (state.historyIndex === -1) {
              // Start browsing history - save current input
              state.originalBuffer = state.buffer;
              state.historyIndex = commandHistory.length - 1;
            } else if (state.historyIndex > 0) {
              state.historyIndex--;
            }
            // Load history entry
            if (state.historyIndex >= 0) {
              state.buffer = commandHistory[state.historyIndex];
              state.cursor = splitGraphemes(state.buffer).length;
            }
          }
          break;
        case "down":
          if (state.suggestions.length > 0) {
            // Navigate suggestions if available
            state.suggestionIndex =
              (state.suggestionIndex + 1) % state.suggestions.length;
          } else if (state.historyIndex !== -1) {
            // Navigate command history
            if (state.historyIndex < commandHistory.length - 1) {
              state.historyIndex++;
              state.buffer = commandHistory[state.historyIndex];
            } else {
              // Reached end of history - restore original input
              state.historyIndex = -1;
              state.buffer = state.originalBuffer;
            }
            state.cursor = splitGraphemes(state.buffer).length;
          }
          break;
        case "word-left":
          moveWordLeft(state);
          break;
        case "word-right":
          moveWordRight(state);
          break;
        case "delete-word-left":
          deleteWordLeft(state);
          break;
        case "delete-word-right":
          deleteWordRight(state);
          break;
        case "delete":
          deleteForward(state);
          break;
        case "home":
        case "line-start":
          moveLineStart(state);
          break;
        case "end":
        case "line-end":
          moveLineEnd(state);
          break;
        default:
          break;
      }
      render();
    };

    const handlePasteChunk = (chunk: string): void => {
      if (chunk.length === 0) {
        return;
      }
      insertText(state, normalizeLineEndings(chunk));
      render();
    };

    const processToken = (token: InputToken): InputAction | null => {
      if (token.type === "escape") {
        applyEscapeAction(token.action);
        return null;
      }
      if (token.type === "ignore") {
        return null;
      }
      if (token.type === "text") {
        return handleTextInput(token.value);
      }
      return null;
    };

    const handleTabCompletion = (): void => {
      if (state.suggestions.length === 0) {
        return;
      }

      const currentMatchIndex = state.suggestions.findIndex(
        (s) => s.value === state.buffer
      );
      const isExactMatch = currentMatchIndex !== -1;
      const hasMultipleSuggestions = state.suggestions.length > 1;
      const cursorAtEnd = state.cursor === splitGraphemes(state.buffer).length;

      if (isExactMatch && hasMultipleSuggestions && cursorAtEnd) {
        // Cycle to the next suggestion
        state.suggestionIndex =
          (currentMatchIndex + 1) % state.suggestions.length;
        const nextSuggestion = state.suggestions[state.suggestionIndex];
        state.buffer = nextSuggestion.value;
        state.cursor = splitGraphemes(nextSuggestion.value).length;
        updateSuggestions(state);
        render();
      } else if (state.suggestionIndex < state.suggestions.length) {
        // Complete with the current suggestion
        const suggestion = state.suggestions[state.suggestionIndex];
        state.buffer = suggestion.value;
        state.cursor = splitGraphemes(suggestion.value).length;
        updateSuggestions(state);
        render();
      }
    };

    const controlHandlers = new Map<number, () => InputAction | null>([
      [CTRL_C, () => "cancel"],
      [
        CTRL_D,
        () =>
          state.buffer.length === 0
            ? "cancel"
            : applyAndRender(() => deleteForward(state)),
      ],
      [CR, () => "submit"],
      [LF, () => "submit"],
      [CTRL_A, () => applyAndRender(() => moveLineStart(state))],
      [CTRL_E, () => applyAndRender(() => moveLineEnd(state))],
      [CTRL_B, () => applyAndRender(() => moveCursorLeft(state))],
      [CTRL_F, () => applyAndRender(() => moveCursorRight(state))],
      [CTRL_W, () => applyAndRender(() => deleteWordLeft(state))],
      [CTRL_U, () => applyAndRender(() => deleteToLineStart(state))],
      [CTRL_K, () => applyAndRender(() => deleteToLineEnd(state))],
      [BACKSPACE_1, () => applyAndRender(() => deleteBackward(state))],
      [BACKSPACE_2, () => applyAndRender(() => deleteBackward(state))],
    ]);

    const handleTextInput = (value: string): InputAction | null => {
      const code = value.charCodeAt(0);
      const handler = controlHandlers.get(code);
      if (handler) {
        return handler();
      }

      if (code === TAB) {
        handleTabCompletion();
        return null;
      }

      if (code < 32) {
        return null;
      }

      // Cancel history browsing when typing
      if (state.historyIndex !== -1) {
        state.historyIndex = -1;
        state.originalBuffer = "";
      }

      insertText(state, normalizeLineEndings(value));
      updateSuggestions(state);
      render();
      return null;
    };

    const handleSequence = (sequence: string): InputAction | null => {
      if (sequence.length === 0) {
        return null;
      }
      if (sequence.startsWith("\x1b")) {
        const token = readEscapeTokenFromSequence(sequence);
        return token ? processToken(token) : null;
      }
      return handleTextInput(sequence);
    };

    const onSequence = (sequence: string) => {
      const action = handleSequence(sequence);
      if (action === "submit") {
        // If suggestions are displayed and cursor is at end, apply the selected suggestion first (like Tab)
        const cursorAtEnd =
          state.cursor === splitGraphemes(state.buffer).length;
        if (
          state.suggestions.length > 0 &&
          state.suggestionIndex < state.suggestions.length &&
          cursorAtEnd &&
          state.buffer !== state.suggestions[state.suggestionIndex].value
        ) {
          // Apply suggestion without submitting (same as Tab behavior)
          const suggestion = state.suggestions[state.suggestionIndex];
          state.buffer = suggestion.value;
          state.cursor = splitGraphemes(suggestion.value).length;
          updateSuggestions(state);
          render();
          return;
        }
        finalize(state.buffer);
        return;
      }
      if (action === "cancel") {
        finalize(null);
      }
    };

    const onData = (data: Buffer) => {
      const decoded = utf8Decoder.decode(data, { stream: true });
      if (decoded.length === 0) {
        return;
      }
      stdinBuffer.process(decoded);
    };

    enableRawMode();
    renderInput(state, prompt, promptPlain);
    stdinBuffer.on("data", onSequence);
    stdinBuffer.on("paste", handlePasteChunk);
    process.stdin.on("data", onData);
  });
};

const run = async (): Promise<void> => {
  // Initialize required tools (ripgrep, tmux)
  await initializeTools();

  // Load skills for autocomplete
  cachedSkills = await loadAllSkills();

  const sessionId = initializeSession();
  console.log(colorize("dim", `Session: ${sessionId}\n`));

  const { thinking, toolFallback, model, provider } = parseCliArgs();
  agentManager.setThinkingEnabled(thinking);
  agentManager.setToolFallbackEnabled(toolFallback);
  if (provider) {
    agentManager.setProvider(provider);
  }
  if (model) {
    agentManager.setModelId(model);
  }

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

      // Add to history (all inputs, not just commands)
      if (
        trimmed.length > 0 &&
        (commandHistory.length === 0 ||
          commandHistory[commandHistory.length - 1] !== trimmed)
      ) {
        commandHistory.push(trimmed);
      }

      if (shouldExitFromInput(trimmed)) {
        break;
      }

      if (isCommand(trimmed)) {
        const result = await executeCommand(trimmed);
        if (isSkillCommandResult(result)) {
          // Inject skill content into conversation
          const skillMessage = `<command-name>/${result.skillId}</command-name>\n\n${result.skillContent}`;
          messageHistory.addUserMessage(skillMessage);
          await handleAgentResponse(rl);
        } else if (result?.message) {
          console.log(result.message);
        }
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
