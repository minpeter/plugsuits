# MODIFY TOOLS KNOWLEDGE BASE

**Generated:** 2026-02-23 14:40 KST
**Scope:** `src/tools/modify/**`

## OVERVIEW
`modify/` owns all write operations: deterministic edits, file creation/overwrite, and deletion.

## STRUCTURE
```text
src/tools/modify/
|- edit-file.ts            # Hashline-native edit engine
|- edit-file.txt           # edit_file description snippet
|- write-file.ts           # Create or overwrite full files
|- write-file.txt          # write_file description snippet
|- delete-file.ts          # Safe file/directory deletion wrapper
`- delete-file.txt         # delete_file description snippet
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Surgical line-anchored edits | `src/tools/modify/edit-file.ts` | Supports hashline ops |
| Hashline integrity logic | `src/tools/utils/hashline/hashline.ts` | Anchors, hashing, and operation ordering |
| Full-file replacement behavior | `src/tools/modify/write-file.ts` | Creates parent directories and returns metadata |
| Deletion semantics and safeguards | `src/tools/modify/delete-file.ts` | Recursive behavior and ignore-missing handling |

## CONVENTIONS
- Prefer hashline edits with `expected_file_hash` for stale-safe deterministic updates.
- Preserve line-ending normalization behavior during write/edit operations.
- Maintain rich failure messages for near-match and context diagnostics.
- Keep all mutation behavior covered by colocated tests before changing edit semantics.

## ANTI-PATTERNS
- Bypassing expected hash checks when deterministic edits are available.
- Replacing anchored edits with non-deterministic text matching.
- Introducing shell-based file mutation flows for behavior already handled here.
- Silencing partial-match or stale-anchor failures instead of surfacing actionable errors.
