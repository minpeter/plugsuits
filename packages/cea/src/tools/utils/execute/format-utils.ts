const TERMINAL_SCREEN_PREFIX = "=== Current Terminal Screen ===";
const TERMINAL_SCREEN_SUFFIX = "=== End of Screen ===";

const TIMEOUT_PREFIX = "[TIMEOUT]";
const BACKGROUND_PREFIX = "[Background process started]";

export function formatTerminalScreen(content: string): string {
  if (!content?.trim()) {
    return "(no visible output)";
  }
  return `${TERMINAL_SCREEN_PREFIX}\n${content.trim()}\n${TERMINAL_SCREEN_SUFFIX}`;
}

export function formatTimeoutMessage(
  timeoutMs: number,
  terminalScreen: string
): string {
  const formattedScreen = formatTerminalScreen(terminalScreen);
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
