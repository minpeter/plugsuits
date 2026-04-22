import { describe, expect, it } from "vitest";
import {
  buildScrollbackPreservingResetGap,
  resetTuiDiffStateForScrollbackPreservingRestart,
} from "./agent-tui";

describe("new session scrollback preservation helpers", () => {
  it("moves to the last row and writes one CRLF per terminal row to push the current viewport into scrollback", () => {
    expect(buildScrollbackPreservingResetGap(3)).toBe("\x1b[3;1H\r\n\r\n\r\n");
  });

  it("still emits at least one newline for degenerate row counts", () => {
    expect(buildScrollbackPreservingResetGap(0)).toBe("\x1b[1;1H\r\n");
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
});
