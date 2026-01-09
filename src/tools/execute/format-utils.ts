const TERMINAL_SCREEN_PREFIX = "=== Current Terminal Screen ===";
const TERMINAL_SCREEN_SUFFIX = "=== End of Screen ===";

const SYSTEM_REMINDER_PREFIX = "[SYSTEM REMINDER]";
const TIMEOUT_PREFIX = "[TIMEOUT]";
const BACKGROUND_PREFIX = "[Background process started]";

export function formatTerminalScreen(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "(no visible output)";
  }
  return `${TERMINAL_SCREEN_PREFIX}\n${trimmed}\n${TERMINAL_SCREEN_SUFFIX}`;
}

export function formatSystemReminder(message: string): string {
  return `${SYSTEM_REMINDER_PREFIX} ${message}`;
}

export function formatTimeoutMessage(
  timeoutMs: number,
  terminalScreen: string
): string {
  const screen = formatTerminalScreen(terminalScreen);
  const reminder = formatSystemReminder(
    "Use shell_interact with '<Ctrl+C>' to interrupt the running process."
  );
  return `${TIMEOUT_PREFIX} Command timed out after ${timeoutMs}ms. The process may still be running.\n\n${screen}\n\n${reminder}`;
}

export function formatBackgroundMessage(terminalScreen: string): string {
  const screen = formatTerminalScreen(terminalScreen);
  const reminder = formatSystemReminder(
    "The process is running in the background. Use shell_interact to check status or send signals."
  );
  return `${BACKGROUND_PREFIX}\n\n${screen}\n\n${reminder}`;
}
