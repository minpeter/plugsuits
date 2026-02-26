import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeReadFile } from "../explore/read-file";
import { executeEditFile } from "./edit-file";

const LINE_REF_REGEX_TEMPLATE = (lineNumber: number): RegExp =>
  new RegExp(`${lineNumber}#([ZPMQVRWSNKTXJBYH]{2})\\|`);

function extractLineRef(readOutput: string, lineNumber: number): string {
  const matched = readOutput.match(LINE_REF_REGEX_TEMPLATE(lineNumber));
  if (!matched?.[1]) {
    throw new Error(`Failed to extract line reference for line ${lineNumber}`);
  }
  return `${lineNumber}#${matched[1]}`;
}

describe("edit_file stress patterns", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "edit-file-stress-test-"));
  });
  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });
  async function lineRefs(
    path: string,
    ...numbers: number[]
  ): Promise<string[]> {
    const readOutput = await executeReadFile({ path });
    return numbers.map((lineNumber) => extractLineRef(readOutput, lineNumber));
  }

  it("replaces line containing hashline-like syntax", async () => {
    const testFile = join(tempDir, "stress-hashline-like.txt");
    writeFileSync(testFile, "alpha\n5#AB|fake hashline\nomega\n");
    const [line2] = await lineRefs(testFile, 2);
    await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: line2, lines: ["literal replaced"] }],
    });
    expect(readFileSync(testFile, "utf-8")).toBe(
      "alpha\nliteral replaced\nomega\n"
    );
  });

  it("handles multiple edits on adjacent lines", async () => {
    const testFile = join(tempDir, "stress-adjacent-edits.txt");
    writeFileSync(testFile, "l1\nl2\nl3\nl4\nl5\n");
    const [line2, line3, line4] = await lineRefs(testFile, 2, 3, 4);
    await executeEditFile({
      path: testFile,
      edits: [
        { op: "replace", pos: line2, lines: ["L2"] },
        { op: "replace", pos: line3, lines: ["L3"] },
        { op: "replace", pos: line4, lines: ["L4"] },
      ],
    });
    expect(readFileSync(testFile, "utf-8")).toBe("l1\nL2\nL3\nL4\nl5\n");
  });

  it("range replace spanning 5 lines down to 2", async () => {
    const testFile = join(tempDir, "stress-range-5-to-2.txt");
    writeFileSync(testFile, "one\ntwo\nthree\nfour\nfive\n");
    const [line1, line5] = await lineRefs(testFile, 1, 5);
    await executeEditFile({
      path: testFile,
      edits: [
        { op: "replace", pos: line1, end: line5, lines: ["new-a", "new-b"] },
      ],
    });
    expect(readFileSync(testFile, "utf-8")).toBe("new-a\nnew-b\n");
  });

  it("simultaneous first and last line edits", async () => {
    const testFile = join(tempDir, "stress-first-last.txt");
    writeFileSync(testFile, "first\nsecond\nthird\nfourth\n");
    const [line1, line4] = await lineRefs(testFile, 1, 4);
    await executeEditFile({
      path: testFile,
      edits: [
        { op: "replace", pos: line1, lines: ["FIRST"] },
        { op: "replace", pos: line4, lines: ["FOURTH"] },
      ],
    });
    expect(readFileSync(testFile, "utf-8")).toBe(
      "FIRST\nsecond\nthird\nFOURTH\n"
    );
  });

  it("append EOF + replace first line in same call", async () => {
    const testFile = join(tempDir, "stress-eof-append-plus-first.txt");
    writeFileSync(testFile, "top\nmiddle\nbottom\n");
    const [line1, line3] = await lineRefs(testFile, 1, 3);
    await executeEditFile({
      path: testFile,
      edits: [
        { op: "replace", pos: line1, lines: ["TOP"] },
        { op: "append", pos: line3, lines: ["tail"] },
      ],
    });
    expect(readFileSync(testFile, "utf-8")).toBe("TOP\nmiddle\nbottom\ntail\n");
  });

  it("replace with content containing regex special chars", async () => {
    const testFile = join(tempDir, "stress-regex-specials.txt");
    writeFileSync(testFile, "offer\nplaceholder\nend\n");
    const [line2] = await lineRefs(testFile, 2);
    await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "replace",
          pos: line2,
          lines: ["price = $99.99 (50% off) [limited*]"],
        },
      ],
    });
    expect(readFileSync(testFile, "utf-8")).toBe(
      "offer\nprice = $99.99 (50% off) [limited*]\nend\n"
    );
  });

  it("expand single line into multiple lines", async () => {
    const testFile = join(tempDir, "stress-expand-line.txt");
    writeFileSync(testFile, "header\nsingle\nfooter\n");
    const [line2] = await lineRefs(testFile, 2);
    await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "replace",
          pos: line2,
          lines: ["part-1", "part-2", "part-3", "part-4"],
        },
      ],
    });
    expect(readFileSync(testFile, "utf-8")).toBe(
      "header\npart-1\npart-2\npart-3\npart-4\nfooter\n"
    );
  });

  it("triple operation: prepend + replace + append on different anchors", async () => {
    const testFile = join(tempDir, "stress-triple-operation.txt");
    writeFileSync(testFile, "one\ntwo\nthree\nfour\nfive\n");
    const [line1, line3, line5] = await lineRefs(testFile, 1, 3, 5);
    await executeEditFile({
      path: testFile,
      edits: [
        { op: "prepend", pos: line1, lines: ["zero"] },
        { op: "replace", pos: line3, lines: ["THREE"] },
        { op: "append", pos: line5, lines: ["six"] },
      ],
    });
    expect(readFileSync(testFile, "utf-8")).toBe(
      "zero\none\ntwo\nTHREE\nfour\nfive\nsix\n"
    );
  });

  it("edit content containing unicode and emoji", async () => {
    const testFile = join(tempDir, "stress-unicode-emoji.txt");
    writeFileSync(testFile, "alpha\n🎉 celebration\nomega\n");
    const [line2] = await lineRefs(testFile, 2);
    await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: line2, lines: ["✅ done — 완료"] }],
    });
    expect(readFileSync(testFile, "utf-8")).toBe(
      "alpha\n✅ done — 완료\nomega\n"
    );
  });

  it("range replace preserving surrounding context", async () => {
    const testFile = join(tempDir, "stress-range-context.txt");
    writeFileSync(
      testFile,
      `${Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n")}\n`
    );
    const [line4, line7] = await lineRefs(testFile, 4, 7);
    await executeEditFile({
      path: testFile,
      edits: [
        { op: "replace", pos: line4, end: line7, lines: ["new-4", "new-5"] },
      ],
    });
    const actualLines = readFileSync(testFile, "utf-8").trimEnd().split("\n");
    expect(actualLines.slice(0, 3)).toEqual(["line-1", "line-2", "line-3"]);
    expect(actualLines.slice(3, 5)).toEqual(["new-4", "new-5"]);
    expect(actualLines.slice(5)).toEqual(["line-8", "line-9", "line-10"]);
  });
});
