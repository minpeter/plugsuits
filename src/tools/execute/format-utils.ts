const TERMINAL_SCREEN_PREFIX = "=== Current Terminal Screen ===";
const TERMINAL_SCREEN_SUFFIX = "=== End of Screen ===";

const CEA_START_MARKER_PATTERN = /__CEA_S_\d+-\d+__/g;
const CEA_EXIT_MARKER_PATTERN = /__CEA_E_\d+-\d+_\d+__/g;

const CEA_START_MARKER_FRAGMENT_LINE_PATTERN =
  /^\s*__CEA_S_\d+-\d+_*(?:__)?\s*$/;
const CEA_EXIT_MARKER_FRAGMENT_LINE_PATTERN =
  /^\s*__CEA_E_\d+-\d+_\d*_*(?:__)?\s*$/;

const CEA_WRAPPER_COMMAND_LINE_PATTERN =
  /\becho\s+__CEA_[SE]_\d+-\d+(?:_\$\?)?__/g;
const TMUX_WAIT_INTERNAL_SUFFIX_PATTERN =
  /\s*;?\s*tmux\s+wait\s+(?:-S\s+)?cea-[0-9a-z-]+\s*$/i;

const SYSTEM_REMINDER_PREFIX = "[SYSTEM REMINDER]";
const TIMEOUT_PREFIX = "[TIMEOUT]";
const BACKGROUND_PREFIX = "[Background process started]";

const MULTIPLE_NEWLINES_PATTERN = /\n{3,}/g;
const LEADING_TRAILING_SEMICOLON_PATTERN = /^\s*;\s*|\s*;\s*$/g;

export function stripInternalMarkers(content: string): string {
  if (!(content.includes("__CEA_") || content.includes("tmux wait"))) {
    return content.trim();
  }

  const cleanedLines: string[] = [];

  for (const line of content.split("\n")) {
    const trimmedLine = line.trim();

    if (
      trimmedLine &&
      (CEA_START_MARKER_FRAGMENT_LINE_PATTERN.test(trimmedLine) ||
        CEA_EXIT_MARKER_FRAGMENT_LINE_PATTERN.test(trimmedLine))
    ) {
      continue;
    }

    let processedLine = line;

    processedLine = processedLine.replace(CEA_WRAPPER_COMMAND_LINE_PATTERN, "");

    processedLine = processedLine.replace(
      TMUX_WAIT_INTERNAL_SUFFIX_PATTERN,
      ""
    );
    processedLine = processedLine
      .replace(CEA_START_MARKER_PATTERN, "")
      .replace(CEA_EXIT_MARKER_PATTERN, "");

    processedLine = processedLine.replace(
      LEADING_TRAILING_SEMICOLON_PATTERN,
      ""
    );

    if (processedLine.trim()) {
      cleanedLines.push(processedLine);
    }
  }

  return cleanedLines
    .join("\n")
    .replace(MULTIPLE_NEWLINES_PATTERN, "\n\n")
    .trim();
}

export function formatTerminalScreen(content: string): string {
  const cleaned = stripInternalMarkers(content);
  if (!cleaned) {
    return "(no visible output)";
  }
  return `${TERMINAL_SCREEN_PREFIX}\n${cleaned}\n${TERMINAL_SCREEN_SUFFIX}`;
}

export function formatSystemReminder(message: string): string {
  return `${SYSTEM_REMINDER_PREFIX} ${message}`;
}

export interface TimeoutMessageOptions {
  sessionId?: string;
  terminalScreen: string;
  timeoutMs: number;
}

export function formatTimeoutMessage(options: TimeoutMessageOptions): string;
export function formatTimeoutMessage(
  timeoutMs: number,
  terminalScreen: string,
  sessionId?: string
): string;
export function formatTimeoutMessage(
  optionsOrTimeoutMs: TimeoutMessageOptions | number,
  terminalScreen?: string,
  _sessionId?: string
): string {
  let timeoutMs: number;
  let screen: string;

  if (typeof optionsOrTimeoutMs === "object") {
    timeoutMs = optionsOrTimeoutMs.timeoutMs;
    screen = optionsOrTimeoutMs.terminalScreen;
  } else {
    timeoutMs = optionsOrTimeoutMs;
    screen = terminalScreen ?? "";
  }

  const formattedScreen = formatTerminalScreen(screen);

  const timeoutHeader = `${TIMEOUT_PREFIX} Command timed out after ${timeoutMs}ms. The process may still be running.`;

  const reminder = [
    "[POSSIBLE ACTIONS]",
    "• Use shell_interact to send keys to the process",
    "• If the process should continue, increase timeout_ms parameter",
  ].join("\n");

  return `${timeoutHeader}\n\n${formattedScreen}\n\n${reminder}`;
}

export function formatBackgroundMessage(terminalScreen: string): string {
  const screen = formatTerminalScreen(terminalScreen);
  const reminder = [
    "[IMPORTANT] Process started in background.",
    "• VERIFY the service is running before concluding (e.g., curl endpoint, check logs)",
    "• Do NOT assume success without verification",
    "• Use shell_interact to check status or send signals if needed",
  ].join("\n");
  return `${BACKGROUND_PREFIX}\n\n${screen}\n\n${reminder}`;
}
