---
"@ai-sdk-tool/tui": patch
---

After a successful assistant turn completes, render a single-line compact placeholder in the status slot instead of the default two-line idle buffer so the final response sits with one blank line above the editor. The full-height placeholder is restored on the next user submission, keeping the streaming spinner's layout stable.
