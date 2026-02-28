import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeGrep } from "../explore/grep";
import { executeReadFile } from "../explore/read-file";
import { executeEditFile } from "./edit-file";
import { resetMissingLinesFailures } from "./edit-file-diagnostics";
import { repairMalformedEdit } from "./edit-file-repair";

const FILE_HASH_REGEX = /^file_hash:\s+([0-9a-f]{8})$/m;
const LINE_REF_REGEX_TEMPLATE = (lineNumber: number): RegExp =>
  new RegExp(`\\b${lineNumber}#([ZPMQVRWSNKTXJBYH]{2})\\|`);
const HASHLINE_LINE_PREFIX_REGEX = /^\d+#/;

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

  it("replaces target line using {line_number}#{hash_id} anchor", async () => {
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
    }, { rootDir: tempDir });

    expect(result).toContain(`Updated ${testFile}`);
    expect(result).toContain("1 edit(s) applied");
    expect(readFileSync(testFile, "utf-8")).toBe("alpha\nBRAVO\ncharlie\n");
  });

  it("accepts grep output line as direct hashline anchor", async () => {
    const testFile = join(tempDir, "hashline-from-grep.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");

    const grepOutput = await executeGrep({
      pattern: "bravo",
      path: tempDir,
      include: "hashline-from-grep.txt",
    });

    const grepLine = grepOutput
      .split("\n")
      .find(
        (line) =>
          line.includes("hashline-from-grep.txt:2#") && line.includes("|bravo")
      );

    if (!grepLine) {
      throw new Error("Failed to extract hashline anchor from grep output");
    }

    await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "replace",
          pos: grepLine,
          lines: ["BRAVO"],
        },
      ],
    }, { rootDir: tempDir });

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
      }, { rootDir: tempDir })
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
      }, { rootDir: tempDir })
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
    }, { rootDir: tempDir });

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
    }, { rootDir: tempDir });

    expect(result).toContain(`Created ${testFile}`);
    expect(result).toContain("1 edit(s) applied");
    expect(readFileSync(testFile, "utf-8")).toBe("created-via-hashline");
  });

  it("rejects empty edits", async () => {
    const testFile = join(tempDir, "hashline-empty-edits.txt");
    writeFileSync(testFile, "a\nb\n");

    await expect(
      executeEditFile({
        path: testFile,
        edits: [],
      }, { rootDir: tempDir })
    ).rejects.toThrow();
  });

  it("rejects no-op edits", async () => {
    const testFile = join(tempDir, "hashline-noop.txt");
    writeFileSync(testFile, "a\nb\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 2);

    const result = await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "replace",
          pos: lineRef,
          lines: ["b"],
        },
      ],
    }, { rootDir: tempDir });
    expect(result).toContain("No changes made");
  });

  it("rejects replace when lines are omitted", async () => {
    const testFile = join(tempDir, "hashline-replace-missing-lines.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 2);

    await expect(
      executeEditFile({
        path: testFile,
        edits: [
          {
            op: "replace",
            pos: lineRef,
          },
        ],
      }, { rootDir: tempDir })
    ).rejects.toThrow("explicit 'lines' field");

    expect(readFileSync(testFile, "utf-8")).toBe("alpha\nbravo\ncharlie\n");
  });

  it("silently deletes lines via replace with null", async () => {
    const testFile = join(tempDir, "hashline-deletion.txt");
    writeFileSync(testFile, "heading\nbody\n");
    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 1);
    const result = await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "replace",
          pos: lineRef,
          lines: null,
        },
      ],
    }, { rootDir: tempDir });
    expect(readFileSync(testFile, "utf-8")).toBe("body\n");
    // No deletion warning — lines: null is intentional deletion
    expect(result).not.toContain("Deleted");
  });

  it("appends after blank line without warnings", async () => {
    const testFile = join(tempDir, "hashline-blank-anchor.txt");
    writeFileSync(testFile, "hello\n\nworld\n");
    const readOutput = await executeReadFile({ path: testFile });
    const blankLineRef = extractLineRef(readOutput, 2);
    const result = await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "append",
          pos: blankLineRef,
          lines: ["inserted"],
        },
      ],
    }, { rootDir: tempDir });
    expect(readFileSync(testFile, "utf-8")).toBe("hello\n\ninserted\nworld\n");
    expect(result).not.toContain("Warnings:");
  });

  it("falls back to end anchor when replace pos is invalid", async () => {
    const testFile = join(tempDir, "hashline-replace-end-fallback.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 2);

    await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "replace",
          pos: "invalid-anchor",
          end: lineRef,
          lines: ["BRAVO"],
        },
      ],
    }, { rootDir: tempDir });

    expect(readFileSync(testFile, "utf-8")).toBe("alpha\nBRAVO\ncharlie\n");
  });

  it("falls back to end anchor when append pos is invalid", async () => {
    const testFile = join(tempDir, "hashline-append-end-fallback.txt");
    writeFileSync(testFile, "alpha\nbravo\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 2);

    await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "append",
          pos: "invalid-anchor",
          end: lineRef,
          lines: ["after-bravo"],
        },
      ],
    }, { rootDir: tempDir });

    expect(readFileSync(testFile, "utf-8")).toBe("alpha\nbravo\nafter-bravo\n");
  });

  it("falls back to pos anchor when prepend end is invalid", async () => {
    const testFile = join(tempDir, "hashline-prepend-pos-fallback.txt");
    writeFileSync(testFile, "alpha\nbravo\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 2);

    await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "prepend",
          pos: lineRef,
          end: "invalid-anchor",
          lines: ["before-bravo"],
        },
      ],
    }, { rootDir: tempDir });

    expect(readFileSync(testFile, "utf-8")).toBe(
      "alpha\nbefore-bravo\nbravo\n"
    );
  });

  it("accepts long hash anchors by truncating to 2 chars", async () => {
    const testFile = join(tempDir, "hashline-long-hash-anchor.txt");
    writeFileSync(testFile, "alpha\nbravo\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 2);
    const longLineRef = `${lineRef}ZZ`;

    await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "replace",
          pos: longLineRef,
          lines: ["BRAVO"],
        },
      ],
    }, { rootDir: tempDir });

    expect(readFileSync(testFile, "utf-8")).toBe("alpha\nBRAVO\n");
  });

  it("rejects multiline pos payload copied from hashline output", async () => {
    const testFile = join(tempDir, "hashline-multiline-pos.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");

    const readOutput = await executeReadFile({ path: testFile });
    const line1 = extractLineRef(readOutput, 1);
    const line2 = extractLineRef(readOutput, 2);
    const line3 = extractLineRef(readOutput, 3);
    const multilinePos = [
      `${line1}|alpha`,
      `${line2}|bravo`,
      `${line3}|charlie`,
    ].join("\n");

    await expect(
      executeEditFile({
        path: testFile,
        edits: [
          {
            op: "replace",
            pos: multilinePos,
          },
        ],
      }, { rootDir: tempDir })
    ).rejects.toThrow("single-line");

    expect(readFileSync(testFile, "utf-8")).toBe("alpha\nbravo\ncharlie\n");
  });

  it("preserves CRLF endings after edit", async () => {
    const testFile = join(tempDir, "hashline-crlf.txt");
    writeFileSync(testFile, "foo\r\nbar\r\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 1);

    await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "replace",
          pos: lineRef,
          lines: ["FOO"],
        },
      ],
    }, { rootDir: tempDir });

    expect(readFileSync(testFile, "utf-8")).toBe("FOO\r\nbar\r\n");
  });

  it("preserves UTF-8 BOM with CRLF endings", async () => {
    const testFile = join(tempDir, "hashline-bom-crlf.txt");
    writeFileSync(testFile, "\uFEFFfoo\r\nbar\r\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 1);

    await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "replace",
          pos: lineRef,
          lines: ["FOO"],
        },
      ],
    }, { rootDir: tempDir });

    expect(readFileSync(testFile, "utf-8")).toBe("\uFEFFFOO\r\nbar\r\n");
  });

  it("rejects non-numeric prefix in pos with diagnostic error", async () => {
    const testFile = join(tempDir, "hashline-line-prefix.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");
    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 1);
    const hash = lineRef.split("#")[1];
    await expect(
      executeEditFile({
        path: testFile,
        edits: [{ op: "replace", pos: `LINE#${hash}`, lines: ["replaced"] }],
      }, { rootDir: tempDir })
    ).rejects.toThrow("not a line number");
  });

  it("suggests correct line number when hash matches a file line", async () => {
    const testFile = join(tempDir, "hashline-suggest.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");
    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 1);
    const hash = lineRef.split("#")[1];
    await expect(
      executeEditFile({
        path: testFile,
        edits: [{ op: "replace", pos: `LINE#${hash}`, lines: ["replaced"] }],
      }, { rootDir: tempDir })
    ).rejects.toThrow("Did you mean");
  });

  it("includes line count in multiline pos rejection", async () => {
    const testFile = join(tempDir, "hashline-multiline-count.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");
    const readOutput = await executeReadFile({ path: testFile });
    const lines = readOutput
      .split("\n")
      .filter((l: string) => HASHLINE_LINE_PREFIX_REGEX.test(l));
    const multilinePos = lines.join("\n");
    await expect(
      executeEditFile({
        path: testFile,
        edits: [{ op: "replace", pos: multilinePos, lines: ["x"] }],
      }, { rootDir: tempDir })
    ).rejects.toThrow("lines");
  });

  it("accepts anchor with diff marker prefix via normalization", async () => {
    const testFile = join(tempDir, "hashline-normalize-prefix.txt");
    writeFileSync(testFile, "alpha\nbravo\n");
    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 1);
    const result = await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: `>>> ${lineRef}`, lines: ["ALPHA"] }],
    }, { rootDir: tempDir });
    expect(result).toContain("1 edit(s) applied");
    expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbravo\n");
  });

  it("rejects append with invalid-only anchor with diagnostic", async () => {
    const testFile = join(tempDir, "hashline-append-invalid.txt");
    writeFileSync(testFile, "alpha\nbravo\n");
    await expect(
      executeEditFile({
        path: testFile,
        edits: [{ op: "append", pos: "LINE#XX", lines: ["inserted"] }],
      }, { rootDir: tempDir })
    ).rejects.toThrow("not a line number");
  });

  // ── diagnoseMissingLines pattern-specific errors ──────────────

  it("Pattern A: pos with |content suffix and no lines → anchor mismatch after content extraction", async () => {
    const testFile = join(tempDir, "diag-pattern-a.txt");
    writeFileSync(testFile, "alpha\nbravo\n");
    await expect(
      executeEditFile({
        path: testFile,
        edits: [{ op: "replace", pos: "1#ZZ|alpha" }],
      }, { rootDir: tempDir })
    ).rejects.toThrow("changed since last read");
  });

  it("Pattern B: pos with Python dict syntax auto-repairs and succeeds", async () => {
    const testFile = join(tempDir, "diag-pattern-b.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");
    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 2);
    const malformedPos = `${lineRef}', 'lines': ['replaced text']}`;

    const result = await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: malformedPos }],
    }, { rootDir: tempDir });

    expect(
      result.includes("Warnings:") || result.includes("Auto-repaired")
    ).toBe(true);
    expect(readFileSync(testFile, "utf-8")).toBe(
      "alpha\nreplaced text\ncharlie\n"
    );
  });

  it("Pattern C: pos with =separator content and no lines → anchor mismatch after content extraction", async () => {
    const testFile = join(tempDir, "diag-pattern-c.txt");
    writeFileSync(testFile, "alpha\nbravo\n");
    await expect(
      executeEditFile({
        path: testFile,
        edits: [{ op: "replace", pos: "1#ZZ=some content here" }],
      }, { rootDir: tempDir })
    ).rejects.toThrow("changed since last read");
  });

  it("Pattern D: pos with XML markup and no lines → explicit lines diagnostic", async () => {
    const testFile = join(tempDir, "diag-pattern-d.txt");
    writeFileSync(testFile, "alpha\nbravo\n");
    await expect(
      executeEditFile({
        path: testFile,
        edits: [
          {
            op: "replace",
            pos: "1#ZZ']}</parameter><parameter>",
          },
        ],
      }, { rootDir: tempDir })
    ).rejects.toThrow("explicit 'lines'");
  });

  it("Pattern B auto-repair: replace with Python dict pos succeeds", async () => {
    const testFile = join(tempDir, "diag-pattern-b-auto-repair-success.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");
    const readOutput = await executeReadFile({ path: testFile });
    const line2Anchor = extractLineRef(readOutput, 2);

    const result = await executeEditFile({
      path: testFile,
      edits: [
        {
          op: "replace",
          pos: `${line2Anchor}', 'lines': ['REPLACED']}`,
        },
      ],
    }, { rootDir: tempDir });

    expect(
      result.includes("Warnings:") || result.includes("Auto-repaired")
    ).toBe(true);
    expect(readFileSync(testFile, "utf-8")).toBe("alpha\nREPLACED\ncharlie\n");
  });

  it("Pattern A: repaired anchor with |content suffix → content extracted as lines and applied", async () => {
    const testFile = join(tempDir, "diag-pattern-a-repaired-content.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");
    const readOutput = await executeReadFile({ path: testFile });
    const line2Anchor = extractLineRef(readOutput, 2);

    const result = await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: `${line2Anchor}|old bravo content` }],
    }, { rootDir: tempDir });

    // Content 'old bravo content' extracted from pos as lines replacement
    expect(result).toContain("Warnings:");
    expect(readFileSync(testFile, "utf-8")).toBe(
      "alpha\nold bravo content\ncharlie\n"
    );
  });

  it("Clean anchor with no lines → mentions the anchor in diagnostic", async () => {
    const testFile = join(tempDir, "diag-clean-anchor.txt");
    writeFileSync(testFile, "alpha\nbravo\n");
    await expect(
      executeEditFile({
        path: testFile,
        edits: [{ op: "replace", pos: "1#ZZ" }],
      }, { rootDir: tempDir })
    ).rejects.toThrow("'lines'");
  });

  it("No pos with no lines → generic missing lines error", async () => {
    const testFile = join(tempDir, "diag-no-pos.txt");
    writeFileSync(testFile, "alpha\nbravo\n");
    await expect(
      executeEditFile({
        path: testFile,
        edits: [{ op: "replace" }],
      }, { rootDir: tempDir })
    ).rejects.toThrow("explicit 'lines'");
  });

  it("Long pos content is truncated in error message", async () => {
    const testFile = join(tempDir, "diag-long-pos.txt");
    writeFileSync(testFile, "alpha\nbravo\n");
    const longPos = `not-an-anchor-${"x".repeat(200)}`;
    await expect(
      executeEditFile({
        path: testFile,
        edits: [{ op: "replace", pos: longPos }],
      }, { rootDir: tempDir })
    ).rejects.toThrow("...");
  });
});

describe("repairMalformedEdit", () => {
  it("A: extracts clean anchor and content as lines from pos with |content suffix", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "2#HR|old content",
    });

    expect(result.edit.pos).toBe("2#HR");
    expect(result.edit.lines).toEqual(["old content"]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("A: preserves existing lines when pos has |content", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "2#HR|old",
      lines: ["new"],
    });

    expect(result.edit.pos).toBe("2#HR");
    expect(result.edit.lines).toEqual(["new"]);
  });

  it("C: extracts anchor and content from pos with =separator", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "2#HR=some content",
    });

    expect(result.edit.pos).toBe("2#HR");
    expect(result.edit.lines).toEqual(["some content"]);
  });

  it("D: extracts anchor from pos with XML markup", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "3#YH']}</parameter><parameter>",
    });

    expect(result.edit.pos).toBe("3#YH");
    expect(result.edit.lines).toBeUndefined();
  });

  it("B: extracts anchor + single-element lines from Python dict", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "3#YH', 'lines': ['new text']}",
    });

    expect(result.edit.pos).toBe("3#YH");
    expect(result.edit.lines).toEqual(["new text"]);
  });

  it("B: extracts multi-element array from embedded lines", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "3#YH', 'lines': ['line1', 'line2']}",
    });

    expect(result.edit.lines).toEqual(["line1", "line2"]);
  });

  it("B: extracts null from embedded lines (deletion)", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "3#YH', 'lines': null}",
    });

    expect(result.edit.lines).toBeNull();
  });

  it("F: extracts anchor and lines from query-string", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "2#SR&lines: ['new']",
    });

    expect(result.edit.pos).toBe("2#SR");
    expect(result.edit.lines).toEqual(["new"]);
  });

  it("E: returns unchanged when pos is clean and lines undefined", () => {
    const edit = { op: "replace" as const, pos: "2#KB" };
    const result = repairMalformedEdit(edit);

    expect(result.edit).toEqual(edit);
    expect(result.warnings.length).toBe(0);
  });

  it("no-op when pos is undefined", () => {
    const edit = { op: "replace" as const };
    const result = repairMalformedEdit(edit);

    expect(result.edit).toEqual(edit);
    expect(result.warnings.length).toBe(0);
  });

  it("no-op when pos has no recognizable anchor", () => {
    const edit = { op: "replace" as const, pos: "garbage text" };
    const result = repairMalformedEdit(edit);

    expect(result.edit).toEqual(edit);
    expect(result.warnings.length).toBe(0);
  });

  it("skips multiline pos", () => {
    const edit = {
      op: "replace" as const,
      pos: "1#HR|alpha\n2#KB|bravo",
    };
    const result = repairMalformedEdit(edit);

    expect(result.edit).toEqual(edit);
    expect(result.warnings.length).toBe(0);
  });

  it("extracts clean anchor from end with |content suffix", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "1#HR",
      end: "3#YH|charlie",
      lines: ["x"],
    });

    expect(result.edit.end).toBe("3#YH");
  });

  it("does NOT extract lines from end field", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "1#HR",
      end: "3#YH', 'lines': ['x']}",
      lines: ["y"],
    });

    expect(result.edit.end).toBe("3#YH");
    expect(result.edit.lines).toEqual(["y"]);
  });

  it("works with append op", () => {
    const result = repairMalformedEdit({ op: "append", pos: "2#HR|content" });

    expect(result.edit.pos).toBe("2#HR");
  });

  it("works with prepend op", () => {
    const result = repairMalformedEdit({ op: "prepend", pos: "2#HR=content" });

    expect(result.edit.pos).toBe("2#HR");
  });

  it("A: skips multiline pos with content (too risky to repair)", () => {
    const edit = {
      op: "replace" as const,
      pos: "2#HR|line one\nline two",
    };
    const result = repairMalformedEdit(edit);

    expect(result.edit).toEqual(edit);
    expect(result.warnings.length).toBe(0);
  });

  it("A: does NOT extract content from pos with XML-like garbage", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "3#YH|</parameter>",
    });

    expect(result.edit.pos).toBe("3#YH");
    expect(result.edit.lines).toBeUndefined();
  });

  it("A: does NOT extract content from pos with JSON closing brackets", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "3#YH|'}]}",
    });

    expect(result.edit.pos).toBe("3#YH");
    expect(result.edit.lines).toBeUndefined();
  });

  it("A: extracts real code content like comments", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "1#KM|// Greeting function",
    });

    expect(result.edit.pos).toBe("1#KM");
    expect(result.edit.lines).toEqual(["// Greeting function"]);
  });

  it("A: extracts code content with = separator", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "5#XY=const x = 42;",
    });

    expect(result.edit.pos).toBe("5#XY");
    expect(result.edit.lines).toEqual(["const x = 42;"]);
  });
});

describe("repeated failure escalation", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "edit-file-escalation-test-"));
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  beforeEach(() => {
    resetMissingLinesFailures();
  });

  async function captureMissingLinesError(
    testFile: string,
    anchor: string
  ): Promise<Error> {
    try {
      await executeEditFile({
        path: testFile,
        edits: [{ op: "replace", pos: anchor }],
      }, { rootDir: tempDir });
      throw new Error("Expected executeEditFile to reject");
    } catch (error) {
      if (error instanceof Error) {
        return error;
      }
      throw error;
    }
  }

  it("first missing-lines failure returns standard diagnostic", async () => {
    const testFile = join(tempDir, "escalation-first-failure.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");

    const readOutput = await executeReadFile({ path: testFile });
    const line2Anchor = extractLineRef(readOutput, 2);
    const error = await captureMissingLinesError(testFile, line2Anchor);

    expect(error.message).toContain("explicit 'lines'");
    expect(error.message).not.toContain("contains");
  });

  it("third identical failure escalates with line content", async () => {
    const testFile = join(tempDir, "escalation-third-failure.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");

    const readOutput = await executeReadFile({ path: testFile });
    const line2Anchor = extractLineRef(readOutput, 2);

    await captureMissingLinesError(testFile, line2Anchor);
    await captureMissingLinesError(testFile, line2Anchor);
    const thirdError = await captureMissingLinesError(testFile, line2Anchor);

    expect(thirdError.message).toContain("explicit 'lines'");
    expect(thirdError.message).toContain("contains 'bravo'");
  });

  it("different anchor resets to standard diagnostic", async () => {
    const testFile = join(tempDir, "escalation-different-anchor.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");

    const readOutput = await executeReadFile({ path: testFile });
    const line1Anchor = extractLineRef(readOutput, 1);
    const line2Anchor = extractLineRef(readOutput, 2);

    await captureMissingLinesError(testFile, line2Anchor);
    await captureMissingLinesError(testFile, line2Anchor);
    await captureMissingLinesError(testFile, line2Anchor);
    const error = await captureMissingLinesError(testFile, line1Anchor);

    expect(error.message).toContain("explicit 'lines'");
    expect(error.message).not.toContain("contains");
  });
});

describe("repairMalformedEdit — end extraction from pos", () => {
  it("B: extracts end anchor from embedded key-value in pos", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "3#QH', 'end': '4#KR', 'lines': ['RESOLVED']",
    });

    expect(result.edit.pos).toBe("3#QH");
    expect(result.edit.end).toBe("4#KR");
    expect(result.edit.lines).toEqual(["RESOLVED"]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("B: extracts end from embedded content, preserves existing end", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "3#QH', 'end': '4#KR'",
      end: "5#AB",
      lines: ["x"],
    });

    // Existing end should NOT be overridden
    expect(result.edit.pos).toBe("3#QH");
    expect(result.edit.end).toBe("5#AB");
  });

  it("B: extracts end but no lines when lines already provided", () => {
    const result = repairMalformedEdit({
      op: "replace",
      pos: "3#QH', 'end': '4#KR', 'lines': ['embedded']",
      lines: ["explicit"],
    });

    expect(result.edit.pos).toBe("3#QH");
    expect(result.edit.end).toBe("4#KR");
    expect(result.edit.lines).toEqual(["explicit"]);
  });
});

describe("soft-reject after repeated failures", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "edit-file-soft-reject-test-"));
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  beforeEach(() => {
    resetMissingLinesFailures();
  });

  it("returns soft-reject string after 6+ identical missing-lines failures", async () => {
    const testFile = join(tempDir, "soft-reject.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\n");

    const readOutput = await executeReadFile({ path: testFile });
    const line2Anchor = extractLineRef(readOutput, 2);

    // First 5 failures should throw errors
    for (let i = 0; i < 5; i++) {
      await expect(
        executeEditFile({
          path: testFile,
          edits: [{ op: "replace", pos: line2Anchor }],
        }, { rootDir: tempDir })
      ).rejects.toThrow("explicit 'lines'");
    }

    // 6th+ failure should return a string (soft-reject) instead of throwing
    const result = await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: line2Anchor }],
    }, { rootDir: tempDir });

    expect(typeof result).toBe("string");
    expect(result).toContain("NOT APPLIED");
    expect(result).toContain(line2Anchor);
    expect(result).toContain("bravo");

    // File should NOT have been changed
    expect(readFileSync(testFile, "utf-8")).toBe("alpha\nbravo\ncharlie\n");
  });

  it("soft-reject suggests write_file as alternative", async () => {
    const testFile = join(tempDir, "soft-reject-alt.txt");
    writeFileSync(testFile, "line1\nline2\n");

    const readOutput = await executeReadFile({ path: testFile });
    const line1Anchor = extractLineRef(readOutput, 1);

    // Trigger 6 failures
    for (let i = 0; i < 6; i++) {
      try {
        await executeEditFile({
          path: testFile,
          edits: [{ op: "replace", pos: line1Anchor }],
        }, { rootDir: tempDir });
      } catch {
        // expected for first 5
      }
    }

    const result = await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: line1Anchor }],
    }, { rootDir: tempDir });

    expect(result).toContain("write_file");
  });

  it("triggers soft-reject via file-level threshold when alternating anchors", async () => {
    const testFile = join(tempDir, "soft-reject-file-bail.txt");
    writeFileSync(testFile, "alpha\nbravo\ncharlie\ndelta\n");

    const readOutput = await executeReadFile({ path: testFile });
    const line1Anchor = extractLineRef(readOutput, 1);
    const line2Anchor = extractLineRef(readOutput, 2);
    const line3Anchor = extractLineRef(readOutput, 3);

    // Alternate between anchors so no single anchor hits ESCALATION_BAIL_THRESHOLD (6)
    // but total file failures exceed FILE_BAIL_THRESHOLD (10)
    const anchors = [line1Anchor, line2Anchor, line3Anchor];
    for (let i = 0; i < 9; i++) {
      try {
        await executeEditFile({
          path: testFile,
          edits: [{ op: "replace", pos: anchors[i % anchors.length] }],
        }, { rootDir: tempDir });
      } catch {
        // expected errors
      }
    }

    // 10th file-level failure should trigger soft-reject
    const result = await executeEditFile({
      path: testFile,
      edits: [{ op: "replace", pos: anchors[0] }],
    }, { rootDir: tempDir });

    expect(typeof result).toBe("string");
    expect(result).toContain("NOT APPLIED");
    expect(result).toContain("write_file");

    // File should NOT have been changed
    expect(readFileSync(testFile, "utf-8")).toBe(
      "alpha\nbravo\ncharlie\ndelta\n"
    );
  });
});

describe("edit_file safety (C-1, C-2, H-1)", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "edit-file-safety-test-"));
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("C-1: blocks path traversal via .. segments", async () => {
    const traversalPath = join(tempDir, "..", "..", "etc", "passwd");
    await expect(
      executeEditFile(
        {
          path: traversalPath,
          edits: [{ op: "append", lines: ["malicious"] }],
        },
        { rootDir: tempDir }
      )
    ).rejects.toThrow(/[Pp]ath traversal blocked/);
  });

  it("C-1: blocks absolute paths outside project root", async () => {
    await expect(
      executeEditFile(
        {
          path: "/tmp/outside-project-edit.txt",
          edits: [{ op: "append", lines: ["bad"] }],
        },
        { rootDir: tempDir }
      )
    ).rejects.toThrow(/[Pp]ath traversal blocked|outside/);
  });

  it("C-2: blocks edits through symlinks", async () => {
    const realFile = join(tempDir, "real-edit-target.txt");
    writeFileSync(realFile, "original\n");
    const symlinkPath = join(tempDir, "symlink-to-edit.txt");
    symlinkSync(realFile, symlinkPath);

    await expect(
      executeEditFile(
        {
          path: symlinkPath,
          edits: [{ op: "append", lines: ["through symlink"] }],
        },
        { rootDir: tempDir }
      )
    ).rejects.toThrow(/symlink/i);

    // Original file should be unchanged
    expect(readFileSync(realFile, "utf-8")).toBe("original\n");
  });

  it("C-2: blocks edits through symlinks pointing outside root", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "outside-edit-root-"));
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "secret data\n");
    const symlinkPath = join(tempDir, "escape-edit-link.txt");
    symlinkSync(outsideFile, symlinkPath);

    try {
      await expect(
        executeEditFile(
          {
            path: symlinkPath,
            edits: [{ op: "append", lines: ["overwrite"] }],
          },
          { rootDir: tempDir }
        )
      ).rejects.toThrow(/symlink/i);
      expect(readFileSync(outsideFile, "utf-8")).toBe("secret data\n");
    } finally {
      rmSync(outsideDir, { recursive: true });
    }
  });

  it("H-1: edit uses atomic write (no temp file residue)", async () => {
    const testFile = join(tempDir, "atomic-edit-test.txt");
    writeFileSync(testFile, "alpha\nbravo\n");

    const readOutput = await executeReadFile({ path: testFile });
    const lineRef = extractLineRef(readOutput, 1);

    await executeEditFile(
      {
        path: testFile,
        edits: [{ op: "replace", pos: lineRef, lines: ["ALPHA"] }],
      },
      { rootDir: tempDir }
    );

    expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbravo\n");

    // Check no .tmp- files remain
    const { readdirSync } = require("node:fs");
    const files: string[] = readdirSync(tempDir);
    const tmpFiles = files.filter((f: string) => f.includes(".tmp-"));
    expect(tmpFiles.length).toBe(0);
  });

  it("allows edits within project root (normal operation)", async () => {
    const safeFile = join(tempDir, "safe-edit.txt");
    writeFileSync(safeFile, "original content\n");

    const readOutput = await executeReadFile({ path: safeFile });
    const lineRef = extractLineRef(readOutput, 1);

    const result = await executeEditFile(
      {
        path: safeFile,
        edits: [{ op: "replace", pos: lineRef, lines: ["updated content"] }],
      },
      { rootDir: tempDir }
    );

    expect(result).toContain("Updated");
    expect(readFileSync(safeFile, "utf-8")).toBe("updated content\n");
  });
});
