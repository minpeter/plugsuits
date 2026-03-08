---
"@ai-sdk-tool/cea": patch
---

fix(security): add path containment and result limit to glob tool

Prevents symlink traversal outside the search directory by resolving
each matched file with `realpath()` and verifying containment. Files
that resolve outside `searchDir` (via symlinks) are silently excluded.
Broken symlinks are also silently skipped. Adds a 10,000-candidate
scan limit before the stat phase to bound computational work, reported
as `glob_limit_reached` in the output.
