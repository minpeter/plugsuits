## Minimal Agent

Minimal OpenAI-compatible example agent built on the workspace packages.

## Requirements

- Node.js 22+
- pnpm 10+
- `AI_API_KEY`

Optional:

- `AI_BASE_URL`
- `AI_MODEL`
- `AI_CONTEXT_LIMIT`
- `SESSION_DIR` — directory where session snapshots are written. Defaults to `.minimal-agent/sessions` in the current working directory.

## Scripts

From the workspace root:

```bash
pnpm --filter @plugsuits/minimal-agent dev
pnpm --filter @plugsuits/minimal-agent build
```

## Workflows

Run from source in watch mode during development:

```bash
pnpm --filter @plugsuits/minimal-agent dev
```

Build the package output:

```bash
pnpm --filter @plugsuits/minimal-agent build
```

Run headless mode directly from source:

```bash
node --conditions=@ai-sdk-tool/source --import tsx packages/minimal-agent/index.ts --prompt "Summarize this repository"
```

## Slash commands

- `/new` (aliases: `/clear`, `/reset`) — start a new session.
- `/reasoning <on|off>` — toggle provider-level reasoning. Persisted across sessions via `@ai-sdk-tool/harness/preferences` in `~/.minimal-agent/settings.json` (user layer) and `./.minimal-agent/settings.json` (workspace layer). Run without arguments to see the current value.

## Persisted preferences

The agent loads preferences from two layered JSON files and applies them before the session starts:

```
~/.minimal-agent/settings.json     ← user-global defaults
./.minimal-agent/settings.json     ← workspace override (write target)
```

The workspace layer overrides the user layer on conflict. Writes land on the workspace layer only — global defaults stay intact.

Adding a new persisted toggle is roughly ten lines of declarative config. The harness ships a `createTogglePreferenceCommand` factory that handles argument parsing, validation, persistence, and response messages:

```typescript
import {
  createLayeredPreferences,
  createTogglePreferenceCommand,
} from "@ai-sdk-tool/harness/preferences";

const prefs = createLayeredPreferences<{ reasoningEnabled?: boolean }>({
  appName: "minimal-agent",
});
let reasoningEnabled =
  (await prefs.store.load())?.reasoningEnabled ?? false;

// Then, inside defineAgent({ commands: [...] }), add:
createTogglePreferenceCommand({
  name: "reasoning",
  preferences: prefs,
  field: "reasoningEnabled",
  get: () => reasoningEnabled,
  set: (next) => {
    reasoningEnabled = next;
  },
});
```

For enum-valued preferences, use `createEnumPreferenceCommand` — same shape, plus a `values` array and optional `parse` / `validate` hooks.

See `preferences.ts` and `index.ts` for the full example.
