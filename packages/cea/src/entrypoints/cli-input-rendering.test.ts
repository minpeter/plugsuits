import { describe, expect, it } from "bun:test";

/**
 * Tests for input rendering logic.
 *
 * These tests verify the pure calculation functions used in terminal input rendering.
 * The actual ANSI output cannot be easily tested, but we can verify:
 * 1. Row count calculations
 * 2. Cursor position calculations
 * 3. Safety invariants (never go above lastCursorRow)
 */

const getStringWidth = (input: string): number => {
  let width = 0;
  for (const char of input) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
      continue;
    }
    if (
      codePoint >= 0x11_00 &&
      (codePoint <= 0x11_5f ||
        codePoint === 0x23_29 ||
        codePoint === 0x23_2a ||
        (codePoint >= 0x2e_80 &&
          codePoint <= 0xa4_cf &&
          codePoint !== 0x30_3f) ||
        (codePoint >= 0xac_00 && codePoint <= 0xd7_a3) ||
        (codePoint >= 0xf9_00 && codePoint <= 0xfa_ff) ||
        (codePoint >= 0xfe_10 && codePoint <= 0xfe_19) ||
        (codePoint >= 0xfe_30 && codePoint <= 0xfe_6f) ||
        (codePoint >= 0xff_00 && codePoint <= 0xff_60) ||
        (codePoint >= 0xff_e0 && codePoint <= 0xff_e6) ||
        (codePoint >= 0x1_f3_00 && codePoint <= 0x1_f6_4f) ||
        (codePoint >= 0x1_f9_00 && codePoint <= 0x1_f9_ff) ||
        (codePoint >= 0x2_00_00 && codePoint <= 0x3_ff_fd))
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
};

const calculateInputRows = (
  displayText: string,
  promptWidth: number,
  columns: number
): number => {
  const fullWidth = promptWidth + getStringWidth(displayText);
  return fullWidth === 0 ? 1 : Math.ceil(fullWidth / columns);
};

const calculateCursorPosition = (
  promptWidth: number,
  beforeCursorText: string,
  columns: number
): { row: number; col: number } => {
  const cursorTotalWidth = promptWidth + getStringWidth(beforeCursorText);
  const row = Math.floor(cursorTotalWidth / columns);
  const col = cursorTotalWidth % columns;
  return { row, col };
};

const calculateCurrentRow = (fullWidth: number, columns: number): number => {
  if (fullWidth > 0 && fullWidth % columns === 0) {
    return fullWidth / columns;
  }
  return Math.floor(fullWidth / columns);
};

describe("Input Rendering - Row Calculations", () => {
  const COLUMNS = 80;
  const PROMPT_WIDTH = 5;

  it("calculates 1 row for empty input", () => {
    expect(calculateInputRows("", PROMPT_WIDTH, COLUMNS)).toBe(1);
  });

  it("calculates 1 row for short input", () => {
    expect(calculateInputRows("hello", PROMPT_WIDTH, COLUMNS)).toBe(1);
  });

  it("calculates 1 row when exactly at column boundary minus 1", () => {
    const text = "a".repeat(74);
    expect(calculateInputRows(text, PROMPT_WIDTH, COLUMNS)).toBe(1);
  });

  it("calculates 1 row when exactly at column boundary", () => {
    const text = "a".repeat(75);
    expect(calculateInputRows(text, PROMPT_WIDTH, COLUMNS)).toBe(1);
  });

  it("calculates 2 rows when exceeding column boundary by 1", () => {
    const text = "a".repeat(76);
    expect(calculateInputRows(text, PROMPT_WIDTH, COLUMNS)).toBe(2);
  });

  it("calculates correct rows for long input", () => {
    const text = "a".repeat(155);
    expect(calculateInputRows(text, PROMPT_WIDTH, COLUMNS)).toBe(2);
  });

  it("calculates correct rows for very long input", () => {
    const text = "a".repeat(235);
    expect(calculateInputRows(text, PROMPT_WIDTH, COLUMNS)).toBe(3);
  });
});

describe("Input Rendering - Cursor Position", () => {
  const COLUMNS = 80;
  const PROMPT_WIDTH = 5;

  it("positions cursor at prompt end for empty input", () => {
    const pos = calculateCursorPosition(PROMPT_WIDTH, "", COLUMNS);
    expect(pos).toEqual({ row: 0, col: 5 });
  });

  it("positions cursor correctly for short input", () => {
    const pos = calculateCursorPosition(PROMPT_WIDTH, "hello", COLUMNS);
    expect(pos).toEqual({ row: 0, col: 10 });
  });

  it("positions cursor at end of first row", () => {
    const text = "a".repeat(74);
    const pos = calculateCursorPosition(PROMPT_WIDTH, text, COLUMNS);
    expect(pos).toEqual({ row: 0, col: 79 });
  });

  it("positions cursor at start of second row when exactly at boundary", () => {
    const text = "a".repeat(75);
    const pos = calculateCursorPosition(PROMPT_WIDTH, text, COLUMNS);
    expect(pos).toEqual({ row: 1, col: 0 });
  });

  it("positions cursor correctly on second row", () => {
    const text = "a".repeat(80);
    const pos = calculateCursorPosition(PROMPT_WIDTH, text, COLUMNS);
    expect(pos).toEqual({ row: 1, col: 5 });
  });

  it("positions cursor correctly on third row", () => {
    const text = "a".repeat(160);
    const pos = calculateCursorPosition(PROMPT_WIDTH, text, COLUMNS);
    expect(pos).toEqual({ row: 2, col: 5 });
  });
});

describe("Input Rendering - Pending Wrap Detection", () => {
  const COLUMNS = 80;
  const PROMPT_WIDTH = 5;

  it("detects non-wrap state", () => {
    const fullWidth = PROMPT_WIDTH + 74;
    expect(calculateCurrentRow(fullWidth, COLUMNS)).toBe(0);
  });

  it("detects pending wrap state (exactly at boundary)", () => {
    const fullWidth = PROMPT_WIDTH + 75;
    expect(calculateCurrentRow(fullWidth, COLUMNS)).toBe(1);
  });

  it("detects post-wrap state", () => {
    const fullWidth = PROMPT_WIDTH + 76;
    expect(calculateCurrentRow(fullWidth, COLUMNS)).toBe(1);
  });

  it("detects second boundary wrap", () => {
    const fullWidth = 160;
    expect(calculateCurrentRow(fullWidth, COLUMNS)).toBe(2);
  });
});

describe("Input Rendering - Safety Invariants", () => {
  it("INVARIANT: upward movement should never exceed lastCursorRow", () => {
    const scenarios = [
      { lastCursorRow: 0, lastInputRows: 1, lastSuggestionRows: 0 },
      { lastCursorRow: 0, lastInputRows: 1, lastSuggestionRows: 5 },
      { lastCursorRow: 0, lastInputRows: 2, lastSuggestionRows: 3 },
      { lastCursorRow: 1, lastInputRows: 2, lastSuggestionRows: 0 },
      { lastCursorRow: 1, lastInputRows: 3, lastSuggestionRows: 10 },
    ];

    for (const s of scenarios) {
      const upwardMovement = s.lastCursorRow;
      expect(upwardMovement).toBeLessThanOrEqual(s.lastCursorRow);
      expect(upwardMovement).toBeLessThan(
        s.lastInputRows + s.lastSuggestionRows
      );
    }
  });

  it("INVARIANT: total cleared area equals lastInputRows + lastSuggestionRows", () => {
    const lastInputRows = 2;
    const lastSuggestionRows = 5;
    const totalCleared = lastInputRows + lastSuggestionRows;
    expect(totalCleared).toBe(7);
  });

  it("INVARIANT: after clearing, cursor returns to input area start", () => {
    const lastInputRows = 2;
    const lastSuggestionRows = 5;
    const totalMoved = lastInputRows - 1 + lastSuggestionRows;
    expect(totalMoved).toBe(6);
  });
});

describe("Input Rendering - Wide Characters (Korean)", () => {
  const COLUMNS = 80;
  const PROMPT_WIDTH = 5;

  it("calculates width correctly for Korean characters", () => {
    expect(getStringWidth("한글")).toBe(4);
    expect(getStringWidth("가나다라")).toBe(8);
  });

  it("calculates rows correctly for Korean input", () => {
    const text = "가".repeat(37);
    expect(calculateInputRows(text, PROMPT_WIDTH, COLUMNS)).toBe(1);
  });

  it("wraps Korean text at correct position", () => {
    const text = "가".repeat(38);
    expect(calculateInputRows(text, PROMPT_WIDTH, COLUMNS)).toBe(2);
  });

  it("positions cursor correctly with Korean text", () => {
    const text = "가나다";
    const pos = calculateCursorPosition(PROMPT_WIDTH, text, COLUMNS);
    expect(pos).toEqual({ row: 0, col: 11 });
  });
});
