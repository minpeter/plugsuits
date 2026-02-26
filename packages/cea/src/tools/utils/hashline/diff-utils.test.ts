import { describe, expect, it } from "bun:test";
import { generateUnifiedDiff } from "./diff-utils";

function createNumberedLines(totalLineCount: number): string {
  return Array.from(
    { length: totalLineCount },
    (_, index) => `line ${index + 1}`
  ).join("\n");
}

describe("generateUnifiedDiff", () => {
  it("creates separate hunks for distant changes", () => {
    const oldContent = createNumberedLines(60);
    const newLines = oldContent.split("\n");
    newLines[4] = "line 5 updated";
    newLines[49] = "line 50 updated";
    const newContent = newLines.join("\n");

    const diff = generateUnifiedDiff(oldContent, newContent, "sample.txt");

    const hunkHeaders = diff.match(/^@@/gm) ?? [];
    expect(hunkHeaders.length).toBe(2);
  });

  it("creates a single hunk for adjacent changes", () => {
    const oldContent = createNumberedLines(20);
    const newLines = oldContent.split("\n");
    newLines[9] = "line 10 updated";
    newLines[10] = "line 11 updated";
    const newContent = newLines.join("\n");

    const diff = generateUnifiedDiff(oldContent, newContent, "sample.txt");

    const hunkHeaders = diff.match(/^@@/gm) ?? [];
    expect(hunkHeaders.length).toBe(1);
    expect(diff).toContain(" line 8");
    expect(diff).toContain(" line 13");
  });

  it("returns a diff string for identical content", () => {
    const oldContent = "alpha\nbeta\ngamma";
    const newContent = "alpha\nbeta\ngamma";

    const diff = generateUnifiedDiff(oldContent, newContent, "sample.txt");

    expect(typeof diff).toBe("string");
    expect(diff).toContain("--- sample.txt");
    expect(diff).toContain("+++ sample.txt");
  });

  it("returns a valid diff when old content is empty", () => {
    const oldContent = "";
    const newContent = "first line\nsecond line";

    const diff = generateUnifiedDiff(oldContent, newContent, "sample.txt");

    expect(diff).toContain("--- sample.txt");
    expect(diff).toContain("+++ sample.txt");
    expect(diff).toContain("+first line");
  });
});
