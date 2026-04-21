---
"@ai-sdk-tool/tui": patch
---

Tighten the ESC interrupt feedback. Drop the eager gray "⚡ Interrupted" system message that was printed the moment ESC was pressed (the red "■ interrupted - tell the model what to do differently." hint already reports the interrupt after the stream finalizes), and hide the idle status placeholder's 2-line buffer below the interrupt hint until the next user input so the hint sits flush against the editor. Normal streaming still renders the placeholder to keep the spinner slot layout stable.
