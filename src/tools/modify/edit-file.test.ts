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

const FILE_HASH_REGEX = /^file_hash:\s+([0-9a-f]{8})$/m;
const LINE_REF_REGEX_TEMPLATE = (lineNumber: number): RegExp =>
  new RegExp(`\\s${lineNumber}#([ZPMQVRWSNKTXJBYH]{2})\\s\\|`);

function extractFileHash(readOutput: string): string {
  const matched = readOutput.match(FILE_HASH_REGEX);
  if (!matched?.[1]) {
    throw new Error("Failed to extract file_hash from read output");
  }
  return matched[1];
}

function extractLineRef(readOutput: string, lineNumber: number): string {
  const matched = readOutput.match(LINE_REF_REGEX_TEMPLATE(lineNumber));
  if (!matched?.[1]) {
    throw new Error(`Failed to extract line reference for line ${lineNumber}`);
  }
  return `${lineNumber}#${matched[1]}`;
}

describe("edit_file (hashline-only)", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "edit-file-test-"));
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("replaces target line using LINE#HASH anchor", async () => {
    const testFile = join(tempDir, "hashline-replace.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 2);
    const fileHash = extractFileHash(readOutput);

    const result = await executeEditFile({
      path: testFile,
      expected_file_hash: fileHash,
      edits: [
        {
          op: "replace",
          pos: lineRef,
          lines: ["BRAVO"],
        },
      ],
    });

    expect(result).toContain("OK - hashline edit");
    expect(result).toContain("file_hash:");
    expect(readFileSync(testFile, "utf-8")).toBe("alpha\nBRAVO\ncharlie\n");
  });

  it("fails with helpful mismatch when anchor is stale", async () => {
    const testFile = join(tempDir, "hashline-stale.txt");
    writeFileSync(testFile, "one\ntwo\nthree\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 2);

    writeFileSync(testFile, "one\nTWO-CHANGED\nthree\n");

    await expect(
      executeEditFile({
        path: testFile,
        edits: [
          {
            op: "replace",
            pos: lineRef,
            lines: ["two-updated"],
          },
        ],
      })
    ).rejects.toThrow("changed since last read");
  });

  it("rejects stale expected_file_hash", async () => {
    const testFile = join(tempDir, "hashline-filehash.txt");
    writeFileSync(testFile, "x\ny\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 2);
    const fileHash = extractFileHash(readOutput);

    writeFileSync(testFile, "x\nY-NEW\n");

    await expect(
      executeEditFile({
        path: testFile,
        expected_file_hash: fileHash,
        edits: [
          {
            op: "replace",
            pos: lineRef,
            lines: ["y-updated"],
          },
        ],
      })
    ).rejects.toThrow("File changed since read_file output");
  });

  it("supports prepend and append in one call", async () => {
    const testFile = join(tempDir, "hashline-insert.txt");
    writeFileSync(testFile, "a\nb\nc\n");

    const readOutput = await executeReadFile({ path: testFile });
    const middleRef = extractLineRef(readOutput, 2);

    await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "prepend",
          pos: middleRef,
          lines: ["before-b"],
        },
        {
          op: "append",
          pos: middleRef,
          lines: ["after-b"],
        },
      ],
    });

    expect(readFileSync(testFile, "utf-8")).toBe(
      "a\nbefore-b\nb\nafter-b\nc\n"
    );
  });

  it("creates missing file with anchorless append", async () => {
    const testFile = join(tempDir, "hashline-create.txt");

    const result = await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "append",
          lines: ["created-via-hashline"],
        },
      ],
    });

    expect(result).toContain("OK - hashline edit");
    expect(readFileSync(testFile, "utf-8")).toBe("created-via-hashline");
  });

  it("rejects empty edits", async () => {
    const testFile = join(tempDir, "hashline-empty-edits.txt");
    writeFileSync(testFile, "a\nb\n");

    await expect(
      executeEditFile({
        path: testFile,
        edits: [],
      })
    ).rejects.toThrow();
  });

  it("rejects no-op edits", async () => {
    const testFile = join(tempDir, "hashline-noop.txt");
    writeFileSync(testFile, "a\nb\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 2);

    await expect(
      executeEditFile({
        path: testFile,
        edits: [
          {
            op: "replace",
            pos: lineRef,
            lines: ["b"],
          },
        ],
      })
    ).rejects.toThrow("No changes made");
  });
});
