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

describe("edit_file whitespace stress patterns", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "edit-file-whitespace-test-"));
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

  it("preserves leading indentation on replace", async () => {
    const testFile = join(tempDir, "stress-indent-leading.txt");
    writeFileSync(testFile, "start\n    indented line\nend\n");
    const [line2] = await lineRefs(testFile, 2);
    await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: line2, lines: ["updated indented line"] }],
    });
    expect(readFileSync(testFile, "utf-8")).toBe(
      "start\n    updated indented line\nend\n"
    );
  });

  it("edits line containing only spaces", async () => {
    const testFile = join(tempDir, "stress-only-spaces-line.txt");
    writeFileSync(testFile, "before\n    \nafter\n");
    const [line2] = await lineRefs(testFile, 2);
    await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: line2, lines: ["filled"] }],
    });
    expect(readFileSync(testFile, "utf-8")).toBe("before\n    filled\nafter\n");
  });

  it("preserves tab indentation", async () => {
    const testFile = join(tempDir, "stress-tab-indent.txt");
    writeFileSync(testFile, "start\n\tfunction foo() {\nend\n");
    const [line2] = await lineRefs(testFile, 2);
    await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: line2, lines: ["return 42;"] }],
    });
    expect(readFileSync(testFile, "utf-8")).toBe("start\n\treturn 42;\nend\n");
  });

  it("inserts blank lines via append", async () => {
    const testFile = join(tempDir, "stress-append-blank-lines.txt");
    writeFileSync(testFile, "anchor\ntail\n");
    const [line1] = await lineRefs(testFile, 1);
    await executeEditFile({
      path: testFile,
      edits: [{ op: "append", pos: line1, lines: ["", "new content", ""] }],
    });
    expect(readFileSync(testFile, "utf-8")).toBe(
      "anchor\n\nnew content\n\ntail\n"
    );
  });

  it("handles trailing spaces in replacement content", async () => {
    const testFile = join(tempDir, "stress-trailing-spaces.txt");
    writeFileSync(testFile, "x\ny\n");
    const [line2] = await lineRefs(testFile, 2);
    await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: line2, lines: ["hello   "] }],
    });
    expect(readFileSync(testFile, "utf-8")).toBe("x\nhello   \n");
  });

  it("edits file with mixed indentation (tabs + spaces)", async () => {
    const testFile = join(tempDir, "stress-mixed-indentation.txt");
    writeFileSync(testFile, "\tif (ok) {\n    run();\n\t    mixed();\n}\n");
    const [line2] = await lineRefs(testFile, 2);
    await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: line2, lines: ["updated();"] }],
    });
    expect(readFileSync(testFile, "utf-8")).toBe(
      "\tif (ok) {\n    updated();\n\t    mixed();\n}\n"
    );
  });
});
