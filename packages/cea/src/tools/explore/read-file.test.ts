import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeReadFile } from "./read-file";

const ISO_DATE_PATTERN = /\d{4}-\d{2}-\d{2}T/;
const FILE_HASH_PATTERN = /file_hash:\s+[0-9a-f]{8}/;
const LINE_TAG_PATTERN = /\d+#(?:[ZPMQVRWSNKTXJBYH]{2})\|/;
const HASHLINE_ALPHABET = "[ZPMQVRWSNKTXJBYH]{2}";
const REGEX_ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;

function buildTaggedLinePattern(lineNumber: number, text: string): RegExp {
  const escaped = text.replaceAll(REGEX_ESCAPE_PATTERN, "\\$&");
  return new RegExp(`${lineNumber}#${HASHLINE_ALPHABET}\\|${escaped}`);
}

describe("executeReadFile", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "read-file-test-"));
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  describe("basic read operations", () => {
    it("reads file and returns structured response", async () => {
      const testFile = join(tempDir, "basic.txt");
      writeFileSync(testFile, "line1\nline2\nline3");

      const result = await executeReadFile({ path: testFile });

      expect(result).toContain("OK - read file");
      expect(result).toContain(`path: ${testFile}`);
      expect(result).toContain("bytes:");
      expect(result).toContain("lines: 3");
      expect(result).toMatch(FILE_HASH_PATTERN);
      expect(result).toContain("range: L1-L3");
      expect(result).toContain("======== basic.txt L1-L3 ========");
      expect(result).toMatch(buildTaggedLinePattern(1, "line1"));
      expect(result).toMatch(buildTaggedLinePattern(2, "line2"));
      expect(result).toMatch(buildTaggedLinePattern(3, "line3"));
      expect(result).toContain("======== end ========");
    });

    it("includes last_modified timestamp", async () => {
      const testFile = join(tempDir, "mtime.txt");
      writeFileSync(testFile, "content");

      const result = await executeReadFile({ path: testFile });

      expect(result).toContain("last_modified:");
      expect(result).toMatch(ISO_DATE_PATTERN);
    });
  });

  describe("offset and limit", () => {
    it("respects offset parameter", async () => {
      const testFile = join(tempDir, "offset.txt");
      writeFileSync(testFile, "a\nb\nc\nd\ne");

      const result = await executeReadFile({ path: testFile, offset: 2 });

      expect(result).toContain("range: L3-L5");
      expect(result).toMatch(buildTaggedLinePattern(3, "c"));
      expect(result).toMatch(buildTaggedLinePattern(4, "d"));
      expect(result).toMatch(buildTaggedLinePattern(5, "e"));
      expect(result).not.toMatch(buildTaggedLinePattern(1, "a"));
      expect(result).not.toMatch(buildTaggedLinePattern(2, "b"));
    });

    it("respects limit parameter", async () => {
      const testFile = join(tempDir, "limit.txt");
      writeFileSync(testFile, "a\nb\nc\nd\ne");

      const result = await executeReadFile({ path: testFile, limit: 2 });

      expect(result).toContain("range: L1-L2");
      expect(result).toContain("returned: 2");
      expect(result).toMatch(buildTaggedLinePattern(1, "a"));
      expect(result).toMatch(buildTaggedLinePattern(2, "b"));
    });

    it("combines offset and limit", async () => {
      const testFile = join(tempDir, "combo.txt");
      writeFileSync(testFile, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10");

      const result = await executeReadFile({
        path: testFile,
        offset: 3,
        limit: 3,
      });

      expect(result).toContain("range: L4-L6");
      expect(result).toMatch(buildTaggedLinePattern(4, "4"));
      expect(result).toMatch(buildTaggedLinePattern(5, "5"));
      expect(result).toMatch(buildTaggedLinePattern(6, "6"));
    });
  });

  describe("around_line feature", () => {
    it("reads around specified line with defaults", async () => {
      const testFile = join(tempDir, "around.txt");
      const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
      writeFileSync(testFile, lines.join("\n"));

      const result = await executeReadFile({
        path: testFile,
        around_line: 15,
      });

      expect(result).toContain("L10-L25");
      expect(result).toContain("line15");
      expect(result).toContain("line10");
      expect(result).toContain("line25");
    });

    it("respects before parameter", async () => {
      const testFile = join(tempDir, "before.txt");
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
      writeFileSync(testFile, lines.join("\n"));

      const result = await executeReadFile({
        path: testFile,
        around_line: 10,
        before: 2,
        after: 2,
      });

      expect(result).toContain("L8-L12");
      expect(result).toContain("line8");
      expect(result).toContain("line10");
      expect(result).toContain("line12");
    });

    it("handles around_line at start of file", async () => {
      const testFile = join(tempDir, "start.txt");
      writeFileSync(testFile, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10");

      const result = await executeReadFile({
        path: testFile,
        around_line: 1,
        before: 5,
        after: 3,
      });

      expect(result).toContain("L1-L4");
    });

    it("handles around_line at end of file", async () => {
      const testFile = join(tempDir, "end.txt");
      writeFileSync(testFile, "1\n2\n3\n4\n5");

      const result = await executeReadFile({
        path: testFile,
        around_line: 5,
        before: 2,
        after: 10,
      });

      expect(result).toContain("L3-L5");
    });
  });

  describe("truncation indication", () => {
    it("indicates when file is truncated", async () => {
      const testFile = join(tempDir, "trunc.txt");
      writeFileSync(testFile, "a\nb\nc\nd\ne");

      const result = await executeReadFile({ path: testFile, limit: 2 });

      expect(result).toContain("truncated: true");
    });

    it("indicates when file is not truncated", async () => {
      const testFile = join(tempDir, "notrunc.txt");
      writeFileSync(testFile, "a\nb");

      const result = await executeReadFile({ path: testFile });

      expect(result).toContain("truncated: false");
      expect(result).toMatch(LINE_TAG_PATTERN);
    });
  });

  describe("error handling", () => {
    it("throws error for non-existent file", async () => {
      await expect(
        executeReadFile({ path: join(tempDir, "nonexistent.txt") })
      ).rejects.toThrow();
    });

    it("respects .ignore and .fdignore by default", async () => {
      const isolatedDir = mkdtempSync(join(tmpdir(), "read-ignore-"));
      try {
        const ignoredByDotIgnore = join(isolatedDir, "blocked-ignore.txt");
        const ignoredByFdIgnore = join(isolatedDir, "blocked-fd.txt");
        writeFileSync(join(isolatedDir, ".ignore"), "blocked-ignore.txt\n");
        writeFileSync(join(isolatedDir, ".fdignore"), "blocked-fd.txt\n");
        writeFileSync(ignoredByDotIgnore, "blocked");
        writeFileSync(ignoredByFdIgnore, "blocked");

        await expect(
          executeReadFile({ path: ignoredByDotIgnore })
        ).rejects.toThrow("excluded by ignore rules");
        await expect(
          executeReadFile({ path: ignoredByFdIgnore })
        ).rejects.toThrow("excluded by ignore rules");
      } finally {
        if (existsSync(isolatedDir)) {
          rmSync(isolatedDir, { recursive: true });
        }
      }
    });

    it("can bypass ignore rules when respect_git_ignore is false", async () => {
      const isolatedDir = mkdtempSync(join(tmpdir(), "read-ignore-off-"));
      try {
        const ignoredFile = join(isolatedDir, "blocked.txt");
        writeFileSync(join(isolatedDir, ".ignore"), "blocked.txt\n");
        writeFileSync(ignoredFile, "allowed");

        const result = await executeReadFile({
          path: ignoredFile,
          respect_git_ignore: false,
        });

        expect(result).toContain("OK - read file");
        expect(result).toContain("respect_git_ignore: false");
        expect(result).toMatch(buildTaggedLinePattern(1, "allowed"));
      } finally {
        if (existsSync(isolatedDir)) {
          rmSync(isolatedDir, { recursive: true });
        }
      }
    });

    it("applies parent .gitignore when reading from subdirectory", async () => {
      const repoDir = mkdtempSync(join(tmpdir(), "read-parent-gitignore-"));
      const workspaceDir = join(repoDir, "workspace");
      try {
        mkdirSync(join(repoDir, ".git"));
        mkdirSync(workspaceDir);
        writeFileSync(join(repoDir, ".gitignore"), "/workspace/blocked.txt\n");
        writeFileSync(join(workspaceDir, "blocked.txt"), "blocked");

        await expect(
          executeReadFile({ path: join(workspaceDir, "blocked.txt") })
        ).rejects.toThrow("excluded by ignore rules");
      } finally {
        if (existsSync(repoDir)) {
          rmSync(repoDir, { recursive: true });
        }
      }
    });

    it("applies slashless nested .gitignore patterns to descendants", async () => {
      const repoDir = mkdtempSync(join(tmpdir(), "read-nested-gitignore-"));
      const srcDir = join(repoDir, "src");
      const nestedDir = join(srcDir, "nested");
      try {
        mkdirSync(join(repoDir, ".git"));
        mkdirSync(srcDir);
        mkdirSync(nestedDir);
        writeFileSync(join(srcDir, ".gitignore"), "ignored.ts\n");
        writeFileSync(join(nestedDir, "ignored.ts"), "blocked");

        await expect(
          executeReadFile({ path: join(nestedDir, "ignored.ts") })
        ).rejects.toThrow("excluded by ignore rules");
      } finally {
        if (existsSync(repoDir)) {
          rmSync(repoDir, { recursive: true });
        }
      }
    });

    it("does not bypass ignore rules with relative parent paths", async () => {
      const originalCwd = process.cwd();
      const repoDir = mkdtempSync(join(tmpdir(), "read-relative-parent-"));
      const nestedDir = join(repoDir, "nested");
      try {
        mkdirSync(join(repoDir, ".git"));
        mkdirSync(nestedDir);
        writeFileSync(join(repoDir, ".gitignore"), "/blocked.txt\n");
        writeFileSync(join(repoDir, "blocked.txt"), "blocked");

        process.chdir(nestedDir);
        await expect(
          executeReadFile({ path: "../blocked.txt" })
        ).rejects.toThrow("excluded by ignore rules");
      } finally {
        process.chdir(originalCwd);
        if (existsSync(repoDir)) {
          rmSync(repoDir, { recursive: true });
        }
      }
    });

    it("rejects negative offset", async () => {
      const testFile = join(tempDir, "invalid-offset.txt");
      writeFileSync(testFile, "a\nb\n");

      await expect(
        executeReadFile({
          path: testFile,
          offset: -1,
        })
      ).rejects.toThrow();
    });

    it("rejects non-positive limit", async () => {
      const testFile = join(tempDir, "invalid-limit.txt");
      writeFileSync(testFile, "a\nb\n");

      await expect(
        executeReadFile({
          path: testFile,
          limit: 0,
        })
      ).rejects.toThrow();
    });

    it("rejects binary content even with text extension", async () => {
      const testFile = join(tempDir, "binary.txt");
      writeFileSync(testFile, Buffer.from([0x00, 0x61, 0x62, 0x63]));

      await expect(executeReadFile({ path: testFile })).rejects.toThrow(
        "binary"
      );
    });

    it("allows text files with .lock extension", async () => {
      const testFile = join(tempDir, "plain.lock");
      writeFileSync(testFile, "line1\nline2");

      const result = await executeReadFile({ path: testFile });

      expect(result).toContain("OK - read file");
      expect(result).toMatch(buildTaggedLinePattern(1, "line1"));
      expect(result).toMatch(buildTaggedLinePattern(2, "line2"));
    });
  });
});
