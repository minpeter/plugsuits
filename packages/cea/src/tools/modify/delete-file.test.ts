import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDeleteFile } from "./delete-file";

describe("executeDeleteFile", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "delete-file-test-"));
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  describe("file deletion", () => {
    it("deletes file and returns metadata", async () => {
      const testFile = join(tempDir, "to-delete.txt");
      writeFileSync(testFile, "content to delete");

      const result = await executeDeleteFile({ path: testFile }, { rootDir: tempDir });

      expect(result).toContain("OK - deleted file: to-delete.txt");
      expect(result).toContain(`path: ${testFile}`);
      expect(result).toContain("bytes:");
      expect(result).toContain("last_modified:");
      expect(existsSync(testFile)).toBe(false);
    });

    it("includes correct byte size in response", async () => {
      const testFile = join(tempDir, "sized.txt");
      const content = "12345";
      writeFileSync(testFile, content);

      const result = await executeDeleteFile({ path: testFile }, { rootDir: tempDir });

      expect(result).toContain("bytes: 5");
    });
  });

  describe("directory deletion", () => {
    it("throws error for directory without recursive flag", async () => {
      const testDir = join(tempDir, "dir-no-recursive");
      mkdirSync(testDir);

      await expect(
        executeDeleteFile({ path: testDir }, { rootDir: tempDir })
      ).rejects.toThrow("recursive: true");

      expect(existsSync(testDir)).toBe(true);
    });

    it("deletes empty directory with recursive flag", async () => {
      const testDir = join(tempDir, "empty-dir");
      mkdirSync(testDir);

      const result = await executeDeleteFile(
        { path: testDir, recursive: true },
        { rootDir: tempDir }
      );

      expect(result).toContain("OK - deleted directory: empty-dir");
      expect(result).toContain(`path: ${testDir}`);
      expect(result).toContain("last_modified:");
      expect(existsSync(testDir)).toBe(false);
    });

    it("deletes non-empty directory with recursive flag", async () => {
      const testDir = join(tempDir, "non-empty-dir");
      mkdirSync(testDir);
      writeFileSync(join(testDir, "file1.txt"), "content1");
      writeFileSync(join(testDir, "file2.txt"), "content2");
      mkdirSync(join(testDir, "subdir"));
      writeFileSync(join(testDir, "subdir", "nested.txt"), "nested");

      const result = await executeDeleteFile(
        { path: testDir, recursive: true },
        { rootDir: tempDir }
      );

      expect(result).toContain("OK - deleted directory: non-empty-dir");
      expect(existsSync(testDir)).toBe(false);
    });
  });

  describe("ignore_missing option", () => {
    it("throws error for non-existent file by default", async () => {
      const nonExistent = join(tempDir, "does-not-exist.txt");

      await expect(executeDeleteFile({ path: nonExistent }, { rootDir: tempDir })).rejects.toThrow();
    });

    it("returns skip message when ignore_missing is true", async () => {
      const nonExistent = join(tempDir, "also-does-not-exist.txt");

      const result = await executeDeleteFile(
        { path: nonExistent, ignore_missing: true },
        { rootDir: tempDir }
      );

      expect(result).toContain("SKIPPED");
      expect(result).toContain("file does not exist");
      expect(result).toContain(nonExistent);
    });
  });

  describe("edge cases", () => {
    it("handles file with special characters in name", async () => {
      const testFile = join(tempDir, "file with spaces.txt");
      writeFileSync(testFile, "content");

      const result = await executeDeleteFile({ path: testFile }, { rootDir: tempDir });

      expect(result).toContain("OK - deleted file: file with spaces.txt");
      expect(existsSync(testFile)).toBe(false);
    });

    it("handles empty file", async () => {
      const testFile = join(tempDir, "empty-file.txt");
      writeFileSync(testFile, "");

      const result = await executeDeleteFile({ path: testFile }, { rootDir: tempDir });

      expect(result).toContain("OK - deleted file: empty-file.txt");
      expect(result).toContain("bytes: 0");
      expect(existsSync(testFile)).toBe(false);
    });
  });

  describe("file safety (C-1, C-2)", () => {
    it("C-1: blocks path traversal via .. segments", async () => {
      const traversalPath = join(tempDir, "..", "..", "etc", "passwd");
      await expect(
        executeDeleteFile({ path: traversalPath }, { rootDir: tempDir })
      ).rejects.toThrow(/[Pp]ath traversal blocked/);
    });

    it("C-1: blocks absolute paths outside project root", async () => {
      await expect(
        executeDeleteFile({ path: "/tmp/outside-project.txt" }, { rootDir: tempDir })
      ).rejects.toThrow(/[Pp]ath traversal blocked|outside/);
    });

    it("C-2: blocks deletion of symlinks", async () => {
      const realFile = join(tempDir, "real-delete-target.txt");
      writeFileSync(realFile, "real content");
      const symlinkPath = join(tempDir, "symlink-to-delete.txt");
      symlinkSync(realFile, symlinkPath);

      await expect(
        executeDeleteFile({ path: symlinkPath }, { rootDir: tempDir })
      ).rejects.toThrow(/symlink/i);

      // Both the symlink and the real file should still exist
      expect(existsSync(symlinkPath)).toBe(true);
      expect(existsSync(realFile)).toBe(true);
      expect(readFileSync(realFile, "utf-8")).toBe("real content");
    });

    it("C-2: blocks deletion of symlinks pointing outside root", async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), "outside-delete-"));
      const outsideFile = join(outsideDir, "secret.txt");
      writeFileSync(outsideFile, "secret data");
      const symlinkPath = join(tempDir, "escape-delete-link.txt");
      symlinkSync(outsideFile, symlinkPath);

      try {
        await expect(
          executeDeleteFile({ path: symlinkPath }, { rootDir: tempDir })
        ).rejects.toThrow(/symlink/i);
        expect(existsSync(outsideFile)).toBe(true);
        expect(readFileSync(outsideFile, "utf-8")).toBe("secret data");
      } finally {
        rmSync(outsideDir, { recursive: true });
      }
    });

    it("allows deletion within project root (normal operation)", async () => {
      const safeFile = join(tempDir, "safe-to-delete.txt");
      writeFileSync(safeFile, "deletable content");

      const result = await executeDeleteFile({ path: safeFile }, { rootDir: tempDir });

      expect(result).toContain("OK - deleted file: safe-to-delete.txt");
      expect(existsSync(safeFile)).toBe(false);
    });
  });
});
