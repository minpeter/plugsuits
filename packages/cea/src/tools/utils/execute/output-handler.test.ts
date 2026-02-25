import { describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { sanitizeOutput, stripAnsi, truncateOutput } from "./output-handler";

describe("stripAnsi", () => {
  test("removes ANSI color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });
});

describe("sanitizeOutput", () => {
  test("removes carriage returns and collapses blank lines", () => {
    const output = "line1\r\nline2\r\n\r\n\r\n\r\nline3\r\n";

    expect(sanitizeOutput(output)).toBe("line1\nline2\n\nline3\n");
  });
});

describe("truncateOutput", () => {
  test("returns original when within limits", async () => {
    const output = "line1\nline2\nline3";

    const result = await truncateOutput(output, {
      maxLines: 10,
      maxBytes: 100,
    });

    expect(result.truncated).toBe(false);
    expect(result.text).toBe(output);
    expect(result.originalLines).toBe(3);
    expect(result.originalBytes).toBe(Buffer.byteLength(output));
    expect(result.fullOutputPath).toBeUndefined();
  });

  test("truncates oversized line-based output and preserves tail", async () => {
    const output = Array.from({ length: 3000 }, (_, i) => `line-${i + 1}`).join(
      "\n"
    );

    const result = await truncateOutput(output);

    expect(result.truncated).toBe(true);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(2000);
    expect(result.text).toContain("line-3000");
    expect(result.fullOutputPath).toBeDefined();
  });

  test("creates a temp file for truncated output", async () => {
    const output = Array.from({ length: 3000 }, (_, i) => `line-${i + 1}`).join(
      "\n"
    );
    const tempPaths: string[] = [];

    try {
      const result = await truncateOutput(output);
      const fullOutputPath = result.fullOutputPath;

      expect(fullOutputPath).toBeDefined();
      if (!fullOutputPath) {
        throw new Error("Expected fullOutputPath to be defined.");
      }
      expect(existsSync(fullOutputPath)).toBe(true);
      tempPaths.push(fullOutputPath);
    } finally {
      for (const path of tempPaths) {
        if (existsSync(path)) {
          unlinkSync(path);
        }
      }
    }
  });
});
