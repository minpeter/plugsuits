---
"@ai-sdk-tool/tui": patch
"plugsuits": patch
"@plugsuits/minimal-agent": patch
---

Polish the TUI area around the prompt so transient status updates and tool-call startup no longer cause avoidable visual jumps.

- Render the foreground loader through `FooterStatusBar` so `Processing...`, `Working...`, `Executing...`, and `Compacting...` share the footer row with context pressure instead of mounting a standalone status block near the editor.
- Rename `CommandPreprocessHooks.statusContainer` to `overlayContainer`; CEA and minimal-agent now mount their slash-command selectors in that overlay container while clearing the footer loader first.
- Make `BaseToolCallView` reserve visible space immediately with a `Preparing tool call…` pending indicator until real tool input arrives, avoiding a zero-height gap at tool-call start.
- Tighten the `✓ New session started` banner spacing, remove the eager gray `⚡ Interrupted` message in favor of the final red interruption hint, and clear footer status when starting a new session.
