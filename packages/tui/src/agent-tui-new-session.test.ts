import { describe, expect, it } from "vitest";
import { buildRestartSessionBlock, formatHeaderTitleText } from "./agent-tui";

describe("new-session restart block helpers", () => {
  it("formats header title text like the live header", () => {
    expect(formatHeaderTitleText("Agent TUI")).toContain("Agent TUI");
    expect(formatHeaderTitleText("Agent TUI", "model: gpt-5.4")).toContain(
      "Agent TUI"
    );
    expect(formatHeaderTitleText("Agent TUI", "model: gpt-5.4")).toContain(
      "model: gpt-5.4"
    );
  });

  it("builds a fresh-session block with header, help, and new-session marker", () => {
    const block = buildRestartSessionBlock({
      headerTitle: "Codex",
      subtitle: "model: gpt-5.4",
    });

    expect(block.headerText).toContain("Codex");
    expect(block.headerText).toContain("model: gpt-5.4");
    expect(block.helpText).toContain("Esc to interrupt");
    expect(block.newSessionText).toContain("✓ New session started");
  });

  it("allows overriding help text for restart block rendering", () => {
    const block = buildRestartSessionBlock({
      headerTitle: "Codex",
      helpText: "Custom help",
    });

    expect(block.helpText).toContain("Custom help");
  });
});
