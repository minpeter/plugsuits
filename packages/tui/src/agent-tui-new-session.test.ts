import { describe, expect, it } from "vitest";
import {
  buildScrollbackPreservingResetGap,
  getRenderedViewportLineCount,
  getStepPhaseForCompletedTurnCount,
  resetTuiDiffStateForScrollbackPreservingRestart,
} from "./agent-tui";
import { addChatComponent } from "./stream-handlers";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";

describe("new session scrollback preservation helpers", () => {
  it("moves to the last row and writes one CRLF per rendered viewport line to push visible content into scrollback", () => {
    expect(buildScrollbackPreservingResetGap(3)).toBe(
      "\x1b[3;1H\r\n\r\n\r\n\x1b[2J\x1b[H"
    );
  });

  it("clears the fresh viewport after pushing prior content into scrollback", () => {
    expect(buildScrollbackPreservingResetGap(24)).toBe(
      `\x1b[24;1H${"\r\n".repeat(24)}\x1b[2J\x1b[H`
    );
  });

  it("preserves only the rendered viewport height when it is shorter than the terminal", () => {
    expect(buildScrollbackPreservingResetGap(24, 7)).toBe(
      `\x1b[24;1H${"\r\n".repeat(7)}\x1b[2J\x1b[H`
    );
  });

  it("still emits at least one newline for degenerate row counts", () => {
    expect(buildScrollbackPreservingResetGap(0)).toBe(
      "\x1b[1;1H\r\n\x1b[2J\x1b[H"
    );
  });

  it("resets TUI diff state without requesting a scrollback-clearing full redraw", () => {
    const tui = {
      cursorRow: 10,
      hardwareCursorRow: 10,
      maxLinesRendered: 10,
      previousHeight: 24,
      previousLines: ["old"],
      previousViewportTop: 4,
      previousWidth: 80,
    } as never;

    resetTuiDiffStateForScrollbackPreservingRestart(tui);

    expect(tui.previousLines).toEqual([]);
    expect(tui.previousWidth).toBe(0);
    expect(tui.previousHeight).toBe(0);
    expect(tui.cursorRow).toBe(0);
    expect(tui.hardwareCursorRow).toBe(0);
    expect(tui.maxLinesRendered).toBe(0);
    expect(tui.previousViewportTop).toBe(0);
  });

  it("derives scrollback preservation height from previous rendered lines, clamped to terminal height", () => {
    const tui = {
      previousLines: ["1", "2", "3", "4", "5", "6", "7"],
    } as never;

    expect(getRenderedViewportLineCount(tui, 24)).toBe(7);
    expect(getRenderedViewportLineCount(tui, 4)).toBe(4);
    expect(getRenderedViewportLineCount({ previousLines: [] } as never, 24)).toBe(
      1
    );
  });

  it("resets to a clean home-position viewport after scrollback preservation", () => {
    const rendered = buildScrollbackPreservingResetGap(24);
    expect(rendered.startsWith("\x1b[24;1H")).toBe(true);
    expect(rendered).toContain("\r\n".repeat(24));
    expect(rendered.endsWith("\x1b[2J\x1b[H")).toBe(true);
  });

  it("treats the first completed turn after a session reset as a fresh new-turn", () => {
    expect(getStepPhaseForCompletedTurnCount(0)).toBe("new-turn");
    expect(getStepPhaseForCompletedTurnCount(1)).toBe("intermediate-step");
  });

  it("models the real /new visible gap as one header spacer plus one chat spacer, not a long reset artifact", () => {
    const headerContainer = new Container();
    const chatContainer = new Container();

    headerContainer.addChild(new Spacer(1));
    headerContainer.addChild(new Text("Code Editing Agent", 1, 0));
    headerContainer.addChild(new Text("Help text", 1, 0));

    addChatComponent(
      chatContainer,
      new Text("✓ New session started", 1, 0)
    );

    const rendered = [...headerContainer.render(80), ...chatContainer.render(80)];
    const blankLineIndexes = rendered
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.trim().length === 0)
      .map(({ index }) => index);

    expect(blankLineIndexes).toEqual([0, 3]);
    expect(rendered[4]).toContain("✓ New session started");
  });
});
