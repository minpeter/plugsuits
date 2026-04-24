import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const BACKSLASH_PATTERN = /\\/g;
const TRAILING_SLASH_PATTERN = /\/+$/;
const CRLF_DETECT_PATTERN = /\r\n/;
const LINE_SPLIT_PATTERN = /\r?\n/;

const LOCK_SUFFIX = ".lock";
const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const LOCK_STALE_THRESHOLD_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 20;

function hasGitWorktreeMarker(dir: string): boolean {
  const gitPath = resolve(dir, ".git");
  if (!existsSync(gitPath)) {
    return false;
  }
  try {
    const st = statSync(gitPath);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/**
 * Locate the `.gitignore` at the git worktree root containing `startDir`.
 *
 * Walks upward from `startDir` and returns the first directory that contains
 * BOTH a `.git` marker (directory or file, to support submodules/worktrees)
 * AND a `.gitignore`. Returns `null` if no git worktree is found, or if the
 * worktree root has no `.gitignore`. We deliberately refuse to fall back to
 * an unrelated ancestor `.gitignore` — that would risk polluting a parent
 * repo's or a user's home-level ignore file.
 */
export function findNearestGitignore(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    if (hasGitWorktreeMarker(current)) {
      const gitignorePath = resolve(current, ".gitignore");
      return existsSync(gitignorePath) ? gitignorePath : null;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function normalizeEntry(entry: string): string {
  return entry
    .replace(BACKSLASH_PATTERN, "/")
    .replace(TRAILING_SLASH_PATTERN, "");
}

function splitLines(content: string): string[] {
  return content.split(LINE_SPLIT_PATTERN);
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  return CRLF_DETECT_PATTERN.test(content) ? "\r\n" : "\n";
}

function isEffectiveIgnoreLine(line: string, normalizedEntry: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return false;
  }
  // Negation lines (`!foo`) are whitelists — they re-include a path rather
  // than declare it as ignored, so they must not suppress our append.
  if (trimmed.startsWith("!")) {
    return false;
  }
  return normalizeEntry(trimmed) === normalizedEntry;
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy-wait is acceptable for sub-100ms lock contention. The lock window
    // is bounded by a single small file rename, so spin time is negligible.
  }
}

function tryRemoveStaleLock(lockPath: string): boolean {
  try {
    const st = statSync(lockPath);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > LOCK_STALE_THRESHOLD_MS) {
      rmSync(lockPath, { force: true });
      return true;
    }
  } catch {
    // Lock vanished between existsSync and stat — treat as released.
    return true;
  }
  return false;
}

function acquireLock(lockPath: string): number | null {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  while (true) {
    try {
      return openSync(lockPath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (tryRemoveStaleLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        return null;
      }
      sleepSync(LOCK_POLL_INTERVAL_MS);
    }
  }
}

function releaseLock(lockPath: string, fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Closing a lock fd that was already invalidated is non-fatal.
  }
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // A stale-lock sweep elsewhere may have already removed it.
  }
}

/**
 * Atomically, idempotently ensure `entry` is present in `gitignorePath`.
 *
 * Algorithm:
 *  1. Acquire an exclusive lock via `openSync(`${path}.lock`, "wx")`. This is
 *     an atomic create-or-fail on POSIX and NTFS. Retry briefly on contention.
 *     Sweep stale locks (older than 30s) to survive crashed writers.
 *  2. Under the lock: read current content, decide whether to append.
 *  3. If appending, write a sibling temp file and `renameSync` it over the
 *     target. The rename is atomic on the same filesystem.
 *  4. Release the lock.
 *
 * Returns `true` iff the file was modified. If the lock can't be acquired
 * within the timeout, returns `false` (best-effort — gitignore maintenance
 * must never block session initialization).
 *
 * The lock prevents the classic lost-update race:
 * - Without a lock, two writers each read the file, each compute `original +
 *   entryA` vs `original + entryB`, and the later `renameSync` silently
 *   overwrites the earlier one.
 * - With the lock, the second writer's read sees the first writer's append
 *   already persisted and adds its own entry on top.
 */
export function ensureGitignoreEntry(
  gitignorePath: string,
  entry: string
): boolean {
  const normalizedEntry = normalizeEntry(entry);
  if (normalizedEntry.length === 0) {
    return false;
  }

  if (!existsSync(gitignorePath)) {
    return false;
  }

  const lockPath = `${gitignorePath}${LOCK_SUFFIX}`;
  const lockFd = acquireLock(lockPath);
  if (lockFd === null) {
    return false;
  }

  try {
    const content = readFileSync(gitignorePath, "utf8");
    const lines = splitLines(content);
    const alreadyListed = lines.some((line) =>
      isEffectiveIgnoreLine(line, normalizedEntry)
    );
    if (alreadyListed) {
      return false;
    }

    const eol = detectLineEnding(content);
    const needsLeadingEol =
      content.length > 0 &&
      !content.endsWith("\n") &&
      !content.endsWith("\r\n");
    const newContent = `${content}${needsLeadingEol ? eol : ""}${normalizedEntry}${eol}`;

    const tempPath = `${gitignorePath}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, newContent, "utf8");
    renameSync(tempPath, gitignorePath);
    return true;
  } finally {
    releaseLock(lockPath, lockFd);
  }
}

/**
 * Compute the gitignore entry path for `targetDir` relative to the directory
 * containing `gitignorePath`. Returns a POSIX-style path, or `null` if the
 * target escapes the gitignore's directory tree (we never write escaping
 * paths into a parent `.gitignore`).
 */
export function gitignoreEntryForDir(
  gitignorePath: string,
  targetDir: string
): string | null {
  const gitignoreDir = dirname(resolve(gitignorePath));
  const absoluteTarget = isAbsolute(targetDir)
    ? resolve(targetDir)
    : resolve(process.cwd(), targetDir);
  const rel = relative(gitignoreDir, absoluteTarget);
  if (rel.length === 0) {
    return null;
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return rel.split(sep).join("/");
}

/**
 * Best-effort: if `targetDir` lives inside a git worktree, ensure it is
 * listed in that worktree's `.gitignore`. Search is anchored at `targetDir`
 * (falling back to the parent directory if `targetDir` does not exist yet),
 * never at `process.cwd()` — the relevant repo is the one containing the
 * storage directory, not the one hosting the caller.
 *
 * All failures are swallowed; gitignore maintenance must never block session
 * initialization. Returns `true` iff the file was modified.
 */
export function ensureDirIgnoredByGit(targetDir: string): boolean {
  try {
    const absoluteTarget = isAbsolute(targetDir)
      ? resolve(targetDir)
      : resolve(process.cwd(), targetDir);
    const searchStart = existsSync(absoluteTarget)
      ? absoluteTarget
      : dirname(absoluteTarget);
    const gitignorePath = findNearestGitignore(searchStart);
    if (gitignorePath === null) {
      return false;
    }
    const entry = gitignoreEntryForDir(gitignorePath, absoluteTarget);
    if (entry === null) {
      return false;
    }
    return ensureGitignoreEntry(gitignorePath, entry);
  } catch {
    return false;
  }
}
