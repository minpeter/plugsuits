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
import { executeGlob } from "./glob";

describe("executeGlob", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "glob-test-"));
    writeFileSync(join(tempDir, "file1.ts"), "content1");
    writeFileSync(join(tempDir, "file2.ts"), "content2");
    writeFileSync(join(tempDir, "file3.js"), "content3");
    mkdirSync(join(tempDir, "sub"));
    writeFileSync(join(tempDir, "sub", "nested.ts"), "nested");
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  describe("basic glob operations", () => {
    it("returns structured response with matches", async () => {
      const result = await executeGlob({ pattern: "**/*.ts", path: tempDir });

      expect(result).toContain("OK - glob");
      expect(result).toContain('pattern: "**/*.ts"');
      expect(result).toContain("file_count:");
      expect(result).toContain("sorted_by: mtime desc");
      expect(result).toContain("======== glob results ========");
      expect(result).toContain(".ts");
      expect(result).toContain("======== end ========");
    });

    it("shows file count correctly", async () => {
      const result = await executeGlob({ pattern: "**/*.ts", path: tempDir });

      expect(result).toContain("file_count: 3");
    });

    it("returns no matches when pattern doesn't match", async () => {
      const result = await executeGlob({ pattern: "**/*.xyz", path: tempDir });

      expect(result).toContain("OK - glob (no matches)");
      expect(result).toContain("file_count: 0");
      expect(result).toContain("(no matches)");
    });
  });

  describe("file listing format", () => {
    it("does not include mtime for each file", async () => {
      const result = await executeGlob({ pattern: "*.ts", path: tempDir });

      expect(result).toContain(".ts");
      expect(result).not.toContain(" | mtime: ");
    });

    it("does not include numbered list", async () => {
      const result = await executeGlob({ pattern: "*.ts", path: tempDir });

      expect(result).toContain(".ts");
      expect(result).not.toContain("   1 |");
      expect(result).not.toContain("   2 |");
    });

    it("includes full path", async () => {
      const result = await executeGlob({ pattern: "*.ts", path: tempDir });

      expect(result).toContain(tempDir);
    });
  });

  describe("recursive search", () => {
    it("finds files in subdirectories with **", async () => {
      const result = await executeGlob({ pattern: "**/*.ts", path: tempDir });

      expect(result).toContain("nested.ts");
      expect(result).toContain("file_count: 3");
    });

    it("respects non-recursive patterns", async () => {
      const result = await executeGlob({ pattern: "*.ts", path: tempDir });

      expect(result).not.toContain("nested.ts");
      expect(result).toContain("file_count: 2");
    });
  });

  describe("metadata in response", () => {
    it("includes all search parameters", async () => {
      const result = await executeGlob({
        pattern: "**/*",
        path: tempDir,
        respect_git_ignore: false,
      });

      expect(result).toContain('pattern: "**/*"');
      expect(result).toContain("respect_git_ignore: false");
      expect(result).toContain("truncated: false");
    });
  });

  describe("ignore behavior", () => {
    it("respects .ignore and .fdignore patterns", async () => {
      const isolatedDir = mkdtempSync(join(tmpdir(), "glob-ignore-"));
      try {
        writeFileSync(join(isolatedDir, ".ignore"), "skip.ignore.txt\n");
        writeFileSync(join(isolatedDir, ".fdignore"), "skip.fd.txt\n");
        writeFileSync(join(isolatedDir, "keep.txt"), "keep");
        writeFileSync(join(isolatedDir, "skip.ignore.txt"), "ignored");
        writeFileSync(join(isolatedDir, "skip.fd.txt"), "ignored");

        const result = await executeGlob({
          pattern: "**/*.txt",
          path: isolatedDir,
        });

        expect(result).toContain("file_count: 1");
        expect(result).toContain("keep.txt");
        expect(result).not.toContain("skip.ignore.txt");
        expect(result).not.toContain("skip.fd.txt");
      } finally {
        if (existsSync(isolatedDir)) {
          rmSync(isolatedDir, { recursive: true });
        }
      }
    });

    it("can bypass ignore rules when respect_git_ignore is false", async () => {
      const isolatedDir = mkdtempSync(join(tmpdir(), "glob-ignore-off-"));
      try {
        writeFileSync(join(isolatedDir, ".ignore"), "skip.ignore.txt\n");
        writeFileSync(join(isolatedDir, ".fdignore"), "skip.fd.txt\n");
        writeFileSync(join(isolatedDir, "keep.txt"), "keep");
        writeFileSync(join(isolatedDir, "skip.ignore.txt"), "ignored");
        writeFileSync(join(isolatedDir, "skip.fd.txt"), "ignored");

        const result = await executeGlob({
          pattern: "**/*.txt",
          path: isolatedDir,
          respect_git_ignore: false,
        });

        expect(result).toContain("file_count: 3");
        expect(result).toContain("keep.txt");
        expect(result).toContain("skip.ignore.txt");
        expect(result).toContain("skip.fd.txt");
      } finally {
        if (existsSync(isolatedDir)) {
          rmSync(isolatedDir, { recursive: true });
        }
      }
    });

    it("applies parent .gitignore when searching from subdirectory", async () => {
      const repoDir = mkdtempSync(join(tmpdir(), "glob-parent-gitignore-"));
      const workspaceDir = join(repoDir, "workspace");
      try {
        mkdirSync(join(repoDir, ".git"));
        mkdirSync(workspaceDir);
        writeFileSync(join(repoDir, ".gitignore"), "/workspace/ignored.ts\n");
        writeFileSync(join(workspaceDir, "ignored.ts"), "ignored");
        writeFileSync(join(workspaceDir, "kept.ts"), "kept");

        const result = await executeGlob({
          pattern: "**/*.ts",
          path: workspaceDir,
        });

        expect(result).toContain("file_count: 1");
        expect(result).toContain("kept.ts");
        expect(result).not.toContain("ignored.ts");
      } finally {
        if (existsSync(repoDir)) {
          rmSync(repoDir, { recursive: true });
        }
      }
    });

    it("applies slashless nested .gitignore patterns to descendants", async () => {
      const repoDir = mkdtempSync(join(tmpdir(), "glob-nested-gitignore-"));
      const srcDir = join(repoDir, "src");
      const nestedDir = join(srcDir, "nested");
      try {
        mkdirSync(join(repoDir, ".git"));
        mkdirSync(srcDir);
        mkdirSync(nestedDir);
        writeFileSync(join(srcDir, ".gitignore"), "ignored.ts\n");
        writeFileSync(join(srcDir, "ignored.ts"), "ignored");
        writeFileSync(join(nestedDir, "ignored.ts"), "ignored");
        writeFileSync(join(nestedDir, "kept.ts"), "kept");

        const result = await executeGlob({
          pattern: "**/*.ts",
          path: repoDir,
        });

        expect(result).toContain("file_count: 1");
        expect(result).toContain("kept.ts");
        expect(result).not.toContain("ignored.ts");
      } finally {
        if (existsSync(repoDir)) {
          rmSync(repoDir, { recursive: true });
        }
      }
    });
  });
});
