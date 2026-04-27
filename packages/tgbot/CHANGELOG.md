# @plugsuits/tgbot

## 0.1.5

### Patch Changes

- a6b8a5f: `FileSnapshotStore` now takes a top-level directory (e.g. `.plugsuits`, `.minimal-agent`) and manages its internal layout itself: session snapshots land in `<root>/sessions/*.jsonl`. The public `rootDir` / `sessionsDir` getters expose the resolved paths for consumers that want to co-locate related files (e.g. session memory).

  When the root directory lives inside a git worktree (detected by a sibling `.git` marker, directory or file), the store appends the top-level directory to that worktree's `.gitignore` if not already listed. The update is concurrency-safe: an exclusive `.gitignore.lock` (via `openSync(path, "wx")`) serializes writers, and the content swap is atomic (temp-file + rename). Stale locks older than 30s are reclaimed so a crashed writer can't wedge the next caller. The file's existing line-ending convention is preserved (LF or CRLF), and the helper refuses to write to any ancestor `.gitignore` that is not at a verified worktree root — so it cannot accidentally modify a parent repo's or a user's home-level ignore file. Disable with `new FileSnapshotStore(dir, { autoGitignore: false })`.

  Env var migrations (no backward compatibility):

  - `minimal-agent`: `SESSION_DIR` → `MINIMAL_AGENT_DIR` (default `.minimal-agent`)
  - `tgbot`: `SESSION_DIR` → `TGBOT_DIR` (default `<tmpdir>/tgbot`)

  CEA now constructs its store with `.plugsuits` as the top-level directory and derives its session-memory path from `store.sessionsDir`.

  The previously-undocumented `getFilePath` fallback for unencoded session filenames has been removed; session files always live at `<sessionsDir>/<encodeSessionId(sessionId)>.jsonl`.

- Updated dependencies [a6b8a5f]
- Updated dependencies [c40f690]
- Updated dependencies [54125d0]
  - @ai-sdk-tool/harness@1.3.3

## 0.1.4

### Patch Changes

- 5bb3997: Update direct and transitive dependency resolutions across the monorepo, including AI SDK packages, tooling, TypeScript, and runtime adapters. Raise the declared Node.js support floor to 22.19.0 to match upgraded runtime dependencies such as undici 8.
- Updated dependencies [e937dc7]
- Updated dependencies [5bb3997]
- Updated dependencies [8b1919c]
- Updated dependencies [8b1919c]
- Updated dependencies [496ffdb]
  - @ai-sdk-tool/harness@1.3.1

## 0.1.3

### Patch Changes

- Updated dependencies [a714664]
  - @ai-sdk-tool/harness@1.3.0

## 0.1.2

### Patch Changes

- 5e0768c: Fix review issues: runAgentLoop message retention, isContextOverflowError call sites, setTimeout leak, CEA token estimation, session history separation, per-thread memory tracking, vi.mock hoisting, AgentError export, and lint cleanup
- Updated dependencies [5e0768c]
  - @ai-sdk-tool/harness@1.2.4

## 0.1.1

### Patch Changes

- Updated dependencies [bd8bd8a]
  - @ai-sdk-tool/harness@1.2.3
