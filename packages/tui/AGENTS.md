# TUI PACKAGE — AGENT KNOWLEDGE BASE

Package: `@ai-sdk-tool/tui`
Source: `packages/tui/src/`

## OVERVIEW

This package provides terminal UI primitives for building interactive agent sessions. It wraps `@mariozechner/pi-tui` with agent-specific rendering logic: streaming text views, tool call displays, a spinner, ANSI color helpers, and the top-level `createAgentTUI` function that wires everything into a full interactive loop.

The package has no opinion about which model or tools you use. It depends on `@ai-sdk-tool/harness` for types and the `shouldContinueManualToolLoop` predicate, but the agent itself is passed in as a config parameter.

## KEY EXPORTS

### `createAgentTUI(config: AgentTUIConfig): Promise<void>`

The main entrypoint. Starts a full interactive TUI session: renders a header, accepts user input via an editor widget, dispatches commands, streams agent responses, and handles Ctrl+C gracefully.

```typescript
import { createAgentTUI } from "@ai-sdk-tool/tui";

await createAgentTUI({
  agent,           // { stream(messages, opts?): Promise<AgentStreamResult> }
  messageHistory,  // MessageHistory from @ai-sdk-tool/harness
  header: { title: "My Agent", subtitle: "model: gpt-4o" },
  footer: { text: "Context: 12.4k/128.0k (10%)" },
  commands,        // Command[] — optional, defaults to registered commands
  skills,          // SkillInfo[] — for autocomplete
  toolRenderers,   // ToolRendererMap — custom per-tool rendering
  theme: {
    markdownTheme, // MarkdownTheme from @mariozechner/pi-tui
    editorTheme,   // EditorTheme from @mariozechner/pi-tui
  },
  onSetup,         // async () => void — called once before the input loop
});
```

**Config fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | `{ stream(...) }` | yes | Agent with a `stream` method |
| `messageHistory` | `MessageHistory` | yes | Conversation history instance |
| `header` | `{ title, subtitle? }` | no | Header text shown at the top |
| `footer` | `{ text? }` | no | Text shown below the input editor |
| `commands` | `Command[]` | no | Slash commands; defaults to all registered commands |
| `skills` | `SkillInfo[]` | no | Skills for editor autocomplete |
| `toolRenderers` | `ToolRendererMap` | no | Custom renderers per tool name |
| `theme` | `{ markdownTheme?, editorTheme? }` | no | Visual theme overrides |
| `onSetup` | `() => void \| Promise<void>` | no | One-time setup hook before the loop |

### `AssistantStreamView`

A `Container` subclass that renders streaming assistant output. Handles both `text` and `reasoning` segments, applying distinct ANSI styling to each.

```typescript
import { AssistantStreamView } from "@ai-sdk-tool/tui";

const view = new AssistantStreamView(markdownTheme);
view.appendText("Hello, ");
view.appendReasoning("thinking...");
view.appendText("world!");
```

### `BaseToolCallView`

A `Container` subclass that renders a single tool call — its name, streaming input JSON, and final output or error. Supports custom renderers via `ToolRendererMap`.

```typescript
import { BaseToolCallView, type ToolRendererMap } from "@ai-sdk-tool/tui";

const renderers: ToolRendererMap = {
  read_file: (view, input, output) => {
    view.setRenderedOverride(`read: ${(input as { path: string }).path}`);
  },
};
```

### `Spinner`

A simple braille-frame spinner for non-TUI contexts (e.g., headless scripts that want visual feedback).

```typescript
import { Spinner } from "@ai-sdk-tool/tui";

const spinner = new Spinner("Loading...");
spinner.start();
// ... do work ...
spinner.succeed("Done!");
// or spinner.fail("Something went wrong");
```

**Methods:** `start()`, `stop()`, `succeed(message?)`, `fail(message?)`

Use `setSpinnerOutputEnabled(false)` to suppress all spinner output (useful in tests or piped output).

### `colors` and `colorize`

ANSI color constants and a helper for applying them.

```typescript
import { colors, colorize } from "@ai-sdk-tool/tui";

const highlighted = colorize("cyan", "important text");
// equivalent to: `${colors.cyan}important text${colors.reset}`
```

Available color keys: `blue`, `yellow`, `green`, `cyan`, `red`, `magenta`, `white`, `brightBlue`, `brightGreen`, `brightYellow`, `brightCyan`, `brightMagenta`, `dim`, `bold`, `italic`, `underline`, `gray`, `reset`.

## FILE MAP

| File | Exports | Role |
|------|---------|------|
| `agent-tui.ts` | `createAgentTUI`, `AgentTUIConfig` | Full interactive TUI session loop |
| `stream-views.ts` | `AssistantStreamView` | Streaming text + reasoning renderer |
| `tool-call-view.ts` | `BaseToolCallView`, `ToolRendererMap` | Tool call input/output renderer |
| `stream-handlers.ts` | `STREAM_HANDLERS`, `PiTuiRenderFlags`, `PiTuiStreamState` | Per-part-type stream dispatch table |
| `spinner.ts` | `Spinner`, `setSpinnerOutputEnabled` | Braille spinner for non-TUI use |
| `colors.ts` | `colors`, `colorize` | ANSI color constants and helper |
| `autocomplete.ts` | `createAliasAwareAutocompleteProvider` | Editor autocomplete for commands and skills |

## USAGE PATTERNS

### Minimal setup

```typescript
import { createAgent, MessageHistory } from "@ai-sdk-tool/harness";
import { createAgentTUI } from "@ai-sdk-tool/tui";
import { openai } from "@ai-sdk/openai";

const agent = createAgent({ model: openai("gpt-4o"), instructions: "..." });
const messageHistory = new MessageHistory();

await createAgentTUI({ agent, messageHistory });
```

### Custom tool renderer

```typescript
import { createAgentTUI, type ToolRendererMap } from "@ai-sdk-tool/tui";

const toolRenderers: ToolRendererMap = {
  shell_execute: (view, input) => {
    const cmd = (input as { command: string }).command;
    view.setRenderedOverride(`$ ${cmd}`);
  },
};

await createAgentTUI({ agent, messageHistory, toolRenderers });
```

### Dynamic header (e.g., showing current model)

```typescript
let currentModel = "gpt-4o";

await createAgentTUI({
  agent,
  messageHistory,
  header: {
    title: "My Agent",
    get subtitle() { return `model: ${currentModel}`; },
  },
});
```

## CONVENTIONS

- This package must not import from `@ai-sdk-tool/cea`. Dependency direction: `cea` depends on `tui`, not the reverse.
- `createAgentTUI` owns the full process lifecycle for the TUI session (SIGINT, stdout resize). Do not register competing handlers.
- `BaseToolCallView` and `AssistantStreamView` are `Container` subclasses from `@mariozechner/pi-tui` — they must be added to the TUI tree before rendering.
- `STREAM_HANDLERS` is the authoritative dispatch table for stream part types. Add new part handlers there, not inline in `agent-tui.ts`.

## ANTI-PATTERNS

- Calling `tui.requestRender()` from outside the TUI session (it's a no-op but signals confused ownership).
- Instantiating `BaseToolCallView` or `AssistantStreamView` without adding them to a `Container` — they won't render.
- Using `Spinner` inside a live TUI session — the TUI manages its own loader widget; `Spinner` is for non-TUI scripts.
