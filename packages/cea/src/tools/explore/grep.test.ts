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
import { computeLineHash } from "../utils/hashline";
import { executeGrep } from "./grep";

const HASHLINE_ALPHABET = "[ZPMQVRWSNKTXJBYH]{2}";

describe("executeGrep", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grep-test-"));
    writeFileSync(join(tempDir, "file1.ts"), "const foo = 1;\nconst bar = 2;");
    writeFileSync(
      join(tempDir, "file2.ts"),
      "function foo() {}\nfunction baz() {}"
    );
    mkdirSync(join(tempDir, "sub"));
    writeFileSync(
      join(tempDir, "sub", "nested.ts"),
      "export const foo = 'nested';"
    );
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  describe("basic search", () => {
    it("returns structured response with matches", async () => {
      const result = await executeGrep({ pattern: "foo", path: tempDir });

      expect(result).toContain("OK - grep");
      expect(result).toContain('pattern: "foo"');
      expect(result).toContain("match_count:");
      expect(result).toContain("truncated: false");
      expect(result).toContain("======== grep results ========");
      expect(result).toContain("foo");
      expect(result).toMatch(
        new RegExp(`file1\\.ts[:\\-]1#${HASHLINE_ALPHABET}\\|const foo = 1;`)
      );
      expect(result).toContain("======== end ========");
    });

    it("emits grep lines with line hash markers", async () => {
      const result = await executeGrep({ pattern: "foo", path: tempDir });
      const lineHash = computeLineHash(1, "const foo = 1;");

      expect(result).toContain(`:1#${lineHash}|const foo = 1;`);
      expect(result).toContain("file1.ts");
      expect(result).toContain(":1#");
      expect(result).not.toContain("file1.ts:1:const foo = 1;");
    });

    it("shows match count correctly", async () => {
      const result = await executeGrep({ pattern: "foo", path: tempDir });

      expect(result).toContain("match_count: 3");
    });

    it("returns no matches message when nothing found", async () => {
      const result = await executeGrep({
        pattern: "nonexistent_xyz_123",
        path: tempDir,
      });

      expect(result).toContain("OK - grep (no matches)");
      expect(result).toContain("match_count: 0");
      expect(result).toContain("(no matches)");
    });
  });

  describe("search options", () => {
    it("respects include filter", async () => {
      const result = await executeGrep({
        pattern: "foo",
        path: tempDir,
        include: "file1.ts",
      });

      expect(result).toContain("file1.ts");
      expect(result).not.toContain("file2.ts");
    });

    it("respects case_sensitive option", async () => {
      writeFileSync(join(tempDir, "case.txt"), "FOO\nfoo\nFoo");

      const sensitive = await executeGrep({
        pattern: "foo",
        path: tempDir,
        include: "case.txt",
        case_sensitive: true,
      });

      expect(sensitive).toContain("match_count: 1");

      const insensitive = await executeGrep({
        pattern: "foo",
        path: tempDir,
        include: "case.txt",
        case_sensitive: false,
      });

      expect(insensitive).toContain("match_count: 3");
    });

    it("respects fixed_strings option", async () => {
      writeFileSync(join(tempDir, "regex.txt"), "a.b\na-b\naxb");

      const regex = await executeGrep({
        pattern: "a.b",
        path: tempDir,
        include: "regex.txt",
        fixed_strings: false,
      });

      expect(regex).toContain("match_count: 3");

      const fixed = await executeGrep({
        pattern: "a.b",
        path: tempDir,
        include: "regex.txt",
        fixed_strings: true,
      });

      expect(fixed).toContain("match_count: 1");
    });

    it("formats context lines with hashline markers", async () => {
      writeFileSync(
        join(tempDir, "context.ts"),
        "before line\nneedle target\nafter line"
      );

      const result = await executeGrep({
        pattern: "needle",
        path: tempDir,
        include: "context.ts",
        before: 1,
        after: 1,
      });

      expect(result).toContain(
        `:1#${computeLineHash(1, "before line")}|before line`
      );
      expect(result).toContain(
        `:2#${computeLineHash(2, "needle target")}|needle target`
      );
      expect(result).toContain(
        `:3#${computeLineHash(3, "after line")}|after line`
      );
      expect(result).not.toContain("context.ts-1-before line");
      expect(result).not.toContain("context.ts:2:needle target");
    });
  });

  describe("metadata in response", () => {
    it("includes all search parameters", async () => {
      const result = await executeGrep({
        pattern: "test",
        path: tempDir,
        include: "*.ts",
        case_sensitive: true,
        fixed_strings: true,
      });

      expect(result).toContain('pattern: "test"');
      expect(result).toContain("include: *.ts");
      expect(result).toContain("case_sensitive: true");
      expect(result).toContain("fixed_strings: true");
    });
  });
});
