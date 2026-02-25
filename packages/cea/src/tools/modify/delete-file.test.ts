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

      const result = await executeDeleteFile({ path: testFile });

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

      const result = await executeDeleteFile({ path: testFile });

      expect(result).toContain("bytes: 5");
    });
  });

  describe("directory deletion", () => {
    it("throws error for directory without recursive flag", async () => {
      const testDir = join(tempDir, "dir-no-recursive");
      mkdirSync(testDir);

      await expect(executeDeleteFile({ path: testDir })).rejects.toThrow(
        "recursive: true"
      );

      expect(existsSync(testDir)).toBe(true);
    });

    it("deletes empty directory with recursive flag", async () => {
      const testDir = join(tempDir, "empty-dir");
      mkdirSync(testDir);

      const result = await executeDeleteFile({
        path: testDir,
        recursive: true,
      });

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

      const result = await executeDeleteFile({
        path: testDir,
        recursive: true,
      });

      expect(result).toContain("OK - deleted directory: non-empty-dir");
      expect(existsSync(testDir)).toBe(false);
    });
  });

  describe("ignore_missing option", () => {
    it("throws error for non-existent file by default", async () => {
      const nonExistent = join(tempDir, "does-not-exist.txt");

      await expect(executeDeleteFile({ path: nonExistent })).rejects.toThrow();
    });

    it("returns skip message when ignore_missing is true", async () => {
      const nonExistent = join(tempDir, "also-does-not-exist.txt");

      const result = await executeDeleteFile({
        path: nonExistent,
        ignore_missing: true,
      });

      expect(result).toContain("SKIPPED");
      expect(result).toContain("file does not exist");
      expect(result).toContain(nonExistent);
    });
  });

  describe("edge cases", () => {
    it("handles file with special characters in name", async () => {
      const testFile = join(tempDir, "file with spaces.txt");
      writeFileSync(testFile, "content");

      const result = await executeDeleteFile({ path: testFile });

      expect(result).toContain("OK - deleted file: file with spaces.txt");
      expect(existsSync(testFile)).toBe(false);
    });

    it("handles empty file", async () => {
      const testFile = join(tempDir, "empty-file.txt");
      writeFileSync(testFile, "");

      const result = await executeDeleteFile({ path: testFile });

      expect(result).toContain("OK - deleted file: empty-file.txt");
      expect(result).toContain("bytes: 0");
      expect(existsSync(testFile)).toBe(false);
    });
  });
});
