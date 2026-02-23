import { describe, expect, it } from "bun:test";
import {
  formatBackgroundMessage,
  formatTerminalScreen,
  formatTimeoutMessage,
} from "./format-utils";

describe("formatTerminalScreen", () => {
  it("wraps content with screen markers", () => {
    const result = formatTerminalScreen("hello world");

    expect(result).toContain("=== Current Terminal Screen ===");
    expect(result).toContain("hello world");
    expect(result).toContain("=== End of Screen ===");
  });

  it("returns no visible output message for empty content", () => {
    expect(formatTerminalScreen("")).toBe("(no visible output)");
  });

  it("returns no visible output for whitespace-only content", () => {
    expect(formatTerminalScreen("   \n\n   ")).toBe("(no visible output)");
  });

  it("trims terminal output before wrapping", () => {
    const result = formatTerminalScreen("  hello\nworld  \n");

    expect(result).toContain("hello\nworld");
    expect(result).not.toContain("  ");
  });
});

describe("formatTimeoutMessage", () => {
  it("formats timeout message with terminal screen", () => {
    const result = formatTimeoutMessage(1000, "output");

    expect(result).toContain("[TIMEOUT] Command timed out after 1000ms.");
    expect(result).toContain("=== Current Terminal Screen ===");
    expect(result).toContain("output");
    expect(result).toContain("[POSSIBLE ACTIONS]");
  });
});

describe("formatBackgroundMessage", () => {
  it("formats background message with terminal screen and reminder", () => {
    const result = formatBackgroundMessage("output");

    expect(result).toContain("[Background process started]");
    expect(result).toContain("=== Current Terminal Screen ===");
    expect(result).toContain("output");
    expect(result).toContain("[IMPORTANT] Process started in background.");
  });
});
