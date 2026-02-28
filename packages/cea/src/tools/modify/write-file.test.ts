import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeWriteFile } from "./write-file";

describe("executeWriteFile", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "write-file-test-"));
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  describe("basic write operations", () => {
    it("creates new file and returns metadata", async () => {
      const testFile = join(tempDir, "new.txt");
      const content = "line1\nline2\nline3";

      const result = await executeWriteFile({ path: testFile, content }, { rootDir: tempDir });

      expect(result).toContain("OK - created new.txt");
      expect(result).toContain("bytes:");
      expect(result).toContain("lines: 3");
      expect(result).not.toContain("(preview)");
      expect(result).not.toContain("========");

      const written = readFileSync(testFile, "utf-8");
      expect(written).toBe(content);
    });

    it("overwrites existing file and indicates action", async () => {
      const testFile = join(tempDir, "existing.txt");
      writeFileSync(testFile, "old content");

      const newContent = "new content";
      const result = await executeWriteFile(
        { path: testFile, content: newContent },
        { rootDir: tempDir }
      );

      expect(result).toContain("OK - overwrote existing.txt");
      expect(result).not.toContain("new content");

      const written = readFileSync(testFile, "utf-8");
      expect(written).toBe(newContent);
    });

    it("creates parent directories automatically", async () => {
      const nestedFile = join(tempDir, "deep", "nested", "dir", "file.txt");
      const content = "nested content";

      const result = await executeWriteFile({ path: nestedFile, content }, { rootDir: tempDir });

      expect(result).toContain("OK - created file.txt");
      expect(existsSync(nestedFile)).toBe(true);

      const written = readFileSync(nestedFile, "utf-8");
      expect(written).toBe(content);
    });
  });

  describe("output formatting", () => {
    it("does not include content for small files", async () => {
      const testFile = join(tempDir, "small.txt");
      const content = "a\nb\nc\nd\ne";

      const result = await executeWriteFile({ path: testFile, content }, { rootDir: tempDir });

      expect(result).toContain("bytes:");
      expect(result).toContain("lines: 5");
      expect(result).not.toContain("a\nb\nc\nd\ne");
      expect(result).not.toContain("(preview)");
    });

    it("does not include content for large files", async () => {
      const testFile = join(tempDir, "large.txt");
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
      const content = lines.join("\n");

      const result = await executeWriteFile({ path: testFile, content }, { rootDir: tempDir });

      expect(result).toContain("bytes:");
      expect(result).toContain("lines: 20");
      expect(result).not.toContain("line1");
      expect(result).not.toContain("(preview)");
    });

    it("includes correct byte count", async () => {
      const testFile = join(tempDir, "bytes.txt");
      const content = "hello";

      const result = await executeWriteFile({ path: testFile, content }, { rootDir: tempDir });

      expect(result).toContain("bytes: 5");
    });

    it("handles unicode content correctly", async () => {
      const testFile = join(tempDir, "unicode.txt");
      const content = "한글 테스트\n이모지 🎉";

      const result = await executeWriteFile({ path: testFile, content }, { rootDir: tempDir });

      expect(result).not.toContain("한글 테스트");
      expect(result).not.toContain("이모지 🎉");
      expect(result).toContain("lines: 2");

      const written = readFileSync(testFile, "utf-8");
      expect(written).toBe(content);
    });
  });

  describe("edge cases", () => {
    it("handles empty content", async () => {
      const testFile = join(tempDir, "empty.txt");

      const result = await executeWriteFile({ path: testFile, content: "" }, { rootDir: tempDir });

      expect(result).toContain("OK - created empty.txt");
      expect(result).toContain("bytes: 0");
      expect(result).toContain("lines: 1");

      const written = readFileSync(testFile, "utf-8");
      expect(written).toBe("");
    });

    it("handles single line content", async () => {
      const testFile = join(tempDir, "single.txt");
      const content = "single line without newline";

      const result = await executeWriteFile({ path: testFile, content }, { rootDir: tempDir });

      expect(result).toContain("lines: 1");
      expect(result).not.toContain("single line without newline");
    });

    it("handles content with special characters", async () => {
      const testFile = join(tempDir, "special.txt");
      const content = `const x = { a: 1, b: "test" };\nconst y = \`template \${x}\`;`;

      await executeWriteFile({ path: testFile, content }, { rootDir: tempDir });

      const written = readFileSync(testFile, "utf-8");
      expect(written).toBe(content);
    });
  });

  describe("file safety (C-1, C-2, H-1)", () => {
    it("C-1: blocks path traversal via .. segments", async () => {
      const traversalPath = join(tempDir, "..", "..", "etc", "passwd");
      await expect(
        executeWriteFile({ path: traversalPath, content: "malicious" }, { rootDir: tempDir })
      ).rejects.toThrow(/[Pp]ath traversal blocked/);
    });

    it("C-1: blocks absolute paths outside project root", async () => {
      await expect(
        executeWriteFile({ path: "/tmp/outside-project.txt", content: "bad" }, { rootDir: tempDir })
      ).rejects.toThrow(/[Pp]ath traversal blocked|outside/);
    });

    it("C-2: blocks writes through symlinks", async () => {
      const realFile = join(tempDir, "real-target.txt");
      writeFileSync(realFile, "original");
      const symlinkPath = join(tempDir, "symlink-to-real.txt");
      symlinkSync(realFile, symlinkPath);

      await expect(
        executeWriteFile({ path: symlinkPath, content: "through symlink" }, { rootDir: tempDir })
      ).rejects.toThrow(/symlink/i);

      // Original file should be unchanged
      expect(readFileSync(realFile, "utf-8")).toBe("original");
    });

    it("C-2: blocks writes through symlinks pointing outside root", async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), "outside-root-"));
      const outsideFile = join(outsideDir, "secret.txt");
      writeFileSync(outsideFile, "secret data");
      const symlinkPath = join(tempDir, "escape-link.txt");
      symlinkSync(outsideFile, symlinkPath);

      try {
        await expect(
          executeWriteFile({ path: symlinkPath, content: "overwrite" }, { rootDir: tempDir })
        ).rejects.toThrow(/symlink/i);
        expect(readFileSync(outsideFile, "utf-8")).toBe("secret data");
      } finally {
        rmSync(outsideDir, { recursive: true });
      }
    });

    it("H-1: atomic write produces correct content (no partial writes)", async () => {
      const testFile = join(tempDir, "atomic-test.txt");
      const content = "line1\nline2\nline3";

      await executeWriteFile({ path: testFile, content }, { rootDir: tempDir });

      const written = readFileSync(testFile, "utf-8");
      expect(written).toBe(content);
    });

    it("H-1: no temp files left after successful write", async () => {
      const testFile = join(tempDir, "no-temp-residue.txt");
      await executeWriteFile({ path: testFile, content: "clean" }, { rootDir: tempDir });

      const dirEntries = readFileSync(testFile, "utf-8");
      expect(dirEntries).toBe("clean");

      // Check no .tmp- files remain in the directory
      const { readdirSync } = require("node:fs");
      const files: string[] = readdirSync(tempDir);
      const tmpFiles = files.filter((f: string) => f.includes(".tmp-"));
      expect(tmpFiles.length).toBe(0);
    });

    it("allows writes within project root (normal operation)", async () => {
      const safeFile = join(tempDir, "safe-subdir", "nested.txt");
      const result = await executeWriteFile(
        { path: safeFile, content: "safe content" },
        { rootDir: tempDir }
      );

      expect(result).toContain("OK - created nested.txt");
      expect(readFileSync(safeFile, "utf-8")).toBe("safe content");
    });
  });
});
