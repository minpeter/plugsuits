import { fork } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureDirIgnoredByGit,
  ensureGitignoreEntry,
  findNearestGitignore,
  gitignoreEntryForDir,
} from "./gitignore-sync";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("gitignore-sync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "gitignore-sync-test-")));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("findNearestGitignore", () => {
    it("returns null when there is no .git worktree marker", () => {
      writeFileSync(join(tmpDir, ".gitignore"), "node_modules/\n", "utf8");
      expect(findNearestGitignore(tmpDir)).toBeNull();
    });

    it("returns null when .git exists but no .gitignore is present", () => {
      mkdirSync(join(tmpDir, ".git"));
      expect(findNearestGitignore(tmpDir)).toBeNull();
    });

    it("returns the .gitignore at the .git-adjacent worktree root", () => {
      mkdirSync(join(tmpDir, ".git"));
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\n", "utf8");
      const sub = join(tmpDir, "a", "b");
      mkdirSync(sub, { recursive: true });
      expect(findNearestGitignore(sub)).toBe(gitignorePath);
    });

    it("refuses to fall back to a non-worktree ancestor .gitignore", () => {
      writeFileSync(join(tmpDir, ".gitignore"), "outer\n", "utf8");
      const inner = join(tmpDir, "inner");
      mkdirSync(inner);
      mkdirSync(join(inner, ".git"));
      expect(findNearestGitignore(inner)).toBeNull();
    });

    it("supports `.git` as a file (submodule / git-worktree case)", () => {
      writeFileSync(
        join(tmpDir, ".git"),
        "gitdir: ../.git/worktrees/x\n",
        "utf8"
      );
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\n", "utf8");
      expect(findNearestGitignore(tmpDir)).toBe(gitignorePath);
    });
  });

  describe("ensureGitignoreEntry", () => {
    it("appends missing entry and preserves trailing newline", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\n", "utf8");

      const changed = ensureGitignoreEntry(gitignorePath, ".plugsuits");

      expect(changed).toBe(true);
      expect(readFileSync(gitignorePath, "utf8")).toBe(
        "node_modules/\n.plugsuits\n"
      );
    });

    it("adds missing trailing newline before appending", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/", "utf8");

      ensureGitignoreEntry(gitignorePath, ".plugsuits");

      expect(readFileSync(gitignorePath, "utf8")).toBe(
        "node_modules/\n.plugsuits\n"
      );
    });

    it("is idempotent for exact matches", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, ".plugsuits\n", "utf8");

      const changed = ensureGitignoreEntry(gitignorePath, ".plugsuits");

      expect(changed).toBe(false);
      expect(readFileSync(gitignorePath, "utf8")).toBe(".plugsuits\n");
    });

    it("treats trailing-slash variants as equivalent", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, ".plugsuits/\n", "utf8");

      const changed = ensureGitignoreEntry(gitignorePath, ".plugsuits");

      expect(changed).toBe(false);
    });

    it("ignores comment lines when checking for existing entries", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "# .plugsuits\n", "utf8");

      const changed = ensureGitignoreEntry(gitignorePath, ".plugsuits");

      expect(changed).toBe(true);
    });

    it("treats negated patterns as non-matching and still appends", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "!.plugsuits\n", "utf8");

      const changed = ensureGitignoreEntry(gitignorePath, ".plugsuits");

      expect(changed).toBe(true);
      expect(readFileSync(gitignorePath, "utf8")).toBe(
        "!.plugsuits\n.plugsuits\n"
      );
    });

    it("appends correctly to an empty .gitignore", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "", "utf8");

      const changed = ensureGitignoreEntry(gitignorePath, ".plugsuits");

      expect(changed).toBe(true);
      expect(readFileSync(gitignorePath, "utf8")).toBe(".plugsuits\n");
    });

    it("preserves CRLF line endings when the file uses them", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\r\n", "utf8");

      const changed = ensureGitignoreEntry(gitignorePath, ".plugsuits");

      expect(changed).toBe(true);
      expect(readFileSync(gitignorePath, "utf8")).toBe(
        "node_modules/\r\n.plugsuits\r\n"
      );
    });

    it("detects an already-listed entry inside a CRLF file", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\r\n.plugsuits\r\n", "utf8");

      const changed = ensureGitignoreEntry(gitignorePath, ".plugsuits");

      expect(changed).toBe(false);
    });

    it("returns false when gitignore does not exist", () => {
      const changed = ensureGitignoreEntry(
        join(tmpDir, ".gitignore"),
        ".plugsuits"
      );
      expect(changed).toBe(false);
    });

    it("writes atomically and leaves no temp file behind", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "a\nb\n", "utf8");

      ensureGitignoreEntry(gitignorePath, "c");

      expect(readFileSync(gitignorePath, "utf8")).toBe("a\nb\nc\n");
      const leftover = readdirSync(tmpDir).filter(
        (f) => f.startsWith(".gitignore.") && f.endsWith(".tmp")
      );
      expect(leftover).toHaveLength(0);
    });

    it("preserves both updates under concurrent writers (no lost update)", async () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\n", "utf8");

      const workerScript = join(HERE, "gitignore-sync.concurrent-worker.mjs");
      const runWorker = (entry: string): Promise<number> =>
        new Promise((resolvePromise, rejectPromise) => {
          const child = fork(workerScript, [gitignorePath, entry], {
            stdio: "ignore",
            execArgv: ["--import", "tsx"],
          });
          child.on("exit", (code) => {
            resolvePromise(code ?? -1);
          });
          child.on("error", rejectPromise);
        });

      const [codeA, codeB] = await Promise.all([
        runWorker(".plugsuits"),
        runWorker(".cache"),
      ]);

      expect(codeA).toBe(0);
      expect(codeB).toBe(0);

      const finalContents = readFileSync(gitignorePath, "utf8");
      expect(finalContents).toContain("node_modules/");
      expect(finalContents).toContain(".plugsuits");
      expect(finalContents).toContain(".cache");

      const leftover = readdirSync(tmpDir).filter(
        (f) => f.startsWith(".gitignore.") && f.endsWith(".tmp")
      );
      expect(leftover).toHaveLength(0);
      expect(readdirSync(tmpDir)).not.toContain(".gitignore.lock");
    });
  });

  describe("gitignoreEntryForDir", () => {
    it("returns POSIX-style relative path", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      const target = join(tmpDir, "nested", ".plugsuits");
      expect(gitignoreEntryForDir(gitignorePath, target)).toBe(
        "nested/.plugsuits"
      );
    });

    it("returns null when target escapes gitignore directory", () => {
      const inner = join(tmpDir, "inner");
      mkdirSync(inner);
      const gitignorePath = join(inner, ".gitignore");
      const target = join(tmpDir, ".plugsuits");
      expect(gitignoreEntryForDir(gitignorePath, target)).toBeNull();
    });

    it("returns null when target is the gitignore directory itself", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      expect(gitignoreEntryForDir(gitignorePath, tmpDir)).toBeNull();
    });
  });

  describe("ensureDirIgnoredByGit", () => {
    it("writes to the worktree gitignore containing the target dir, ignoring cwd", () => {
      const worktree = join(tmpDir, "repo");
      mkdirSync(worktree);
      mkdirSync(join(worktree, ".git"));
      const gitignorePath = join(worktree, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\n", "utf8");

      const originalCwd = process.cwd();
      const elsewhere = join(tmpDir, "elsewhere");
      mkdirSync(elsewhere);
      process.chdir(elsewhere);
      try {
        const target = join(worktree, ".plugsuits");
        const changed = ensureDirIgnoredByGit(target);
        expect(changed).toBe(true);
        expect(readFileSync(gitignorePath, "utf8")).toContain(".plugsuits");
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("refuses to write when the target is outside any git worktree", () => {
      const outside = join(tmpDir, "no-repo");
      mkdirSync(outside);
      const gitignorePath = join(outside, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\n", "utf8");

      const changed = ensureDirIgnoredByGit(join(outside, ".plugsuits"));

      expect(changed).toBe(false);
      expect(readFileSync(gitignorePath, "utf8")).toBe("node_modules/\n");
    });

    it("refuses to write when target escapes the worktree root", () => {
      const outer = join(tmpDir, "outer");
      const worktree = join(outer, "repo");
      mkdirSync(worktree, { recursive: true });
      mkdirSync(join(worktree, ".git"));
      const gitignorePath = join(worktree, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\n", "utf8");

      const changed = ensureDirIgnoredByGit(join(outer, ".plugsuits"));

      expect(changed).toBe(false);
      expect(readFileSync(gitignorePath, "utf8")).toBe("node_modules/\n");
    });

    it("handles a target dir that does not exist yet (anchors to parent)", () => {
      mkdirSync(join(tmpDir, ".git"));
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\n", "utf8");

      const future = join(tmpDir, ".plugsuits");
      const changed = ensureDirIgnoredByGit(future);

      expect(changed).toBe(true);
      expect(readFileSync(gitignorePath, "utf8")).toContain(".plugsuits");
    });
  });
});
