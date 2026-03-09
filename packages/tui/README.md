# @ai-sdk-tool/tui

Terminal UI components for building interactive agent sessions. Provides streaming text rendering, tool call displays, a spinner, ANSI color helpers, and a full interactive TUI loop built on [`@mariozechner/pi-tui`](https://github.com/mariozechner/pi-tui).

## Installation

```bash
bun add @ai-sdk-tool/tui
# or
npm install @ai-sdk-tool/tui
```

**Peer dependencies:**

```bash
bun add @ai-sdk-tool/harness ai
```

## Quick Start

```typescript
import { createAgent, MessageHistory } from "@ai-sdk-tool/harness";
import { createAgentTUI } from "@ai-sdk-tool/tui";
import { openai } from "@ai-sdk/openai";

const agent = createAgent({
  model: openai("gpt-4o"),
  instructions: "You are a helpful assistant.",
});

const messageHistory = new MessageHistory();

// Starts a full interactive terminal session.
// Blocks until the user exits (Ctrl+C twice).
await createAgentTUI({
  agent,
  messageHistory,
  header: {
    title: "My Agent",
    subtitle: "model: gpt-4o",
  },
});
```

## API Reference

### `createAgentTUI(config)`

Starts a full interactive TUI session. Renders a header, accepts user input via an editor widget, dispatches slash commands, streams agent responses, and handles Ctrl+C gracefully.

Returns a `Promise<void>` that resolves when the user exits.

```typescript
import { createAgentTUI, type AgentTUIConfig } from "@ai-sdk-tool/tui";

await createAgentTUI({
  agent,           // required — { stream(messages, opts?): Promise<AgentStreamResult> }
  messageHistory,  // required — MessageHistory from @ai-sdk-tool/harness
  header,          // optional — { title: string; subtitle?: string }
  commands,        // optional — Command[] (defaults to all registered commands)
  skills,          // optional — SkillInfo[] for editor autocomplete
  toolRenderers,   // optional — ToolRendererMap for custom per-tool rendering
  theme,           // optional — { markdownTheme?, editorTheme? }
  onSetup,         // optional — async () => void, called once before the input loop
});
```

**Config fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | `{ stream(...) }` | yes | Agent with a `stream` method compatible with `AgentStreamResult` |
| `messageHistory` | `MessageHistory` | yes | Conversation history — the TUI reads and writes to this |
| `header` | `{ title, subtitle? }` | no | Text shown at the top of the terminal |
| `commands` | `Command[]` | no | Slash commands available in the editor; defaults to all registered commands |
| `skills` | `SkillInfo[]` | no | Skills shown in editor autocomplete |
| `toolRenderers` | `ToolRendererMap` | no | Custom renderers keyed by tool name |
| `theme` | `{ markdownTheme?, editorTheme? }` | no | Visual theme overrides for markdown and editor |
| `onSetup` | `() => void \| Promise<void>` | no | One-time async setup hook before the input loop starts |

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| Enter | Submit message |
| Shift+Enter | Insert newline |
| Ctrl+C | Cancel active stream / clear input |
| Ctrl+C twice | Exit |
| Up/Down | Navigate input history |
| Tab | Autocomplete commands and skills |

---

### `AssistantStreamView`

A `Container` subclass that renders streaming assistant output. Handles both `text` and `reasoning` segments with distinct ANSI styling.

```typescript
import { AssistantStreamView } from "@ai-sdk-tool/tui";
import type { MarkdownTheme } from "@mariozechner/pi-tui";

const view = new AssistantStreamView(markdownTheme);

// Append streaming deltas as they arrive
view.appendText("Hello, ");
view.appendReasoning("thinking about the answer...");
view.appendText("world!");
```

**Methods:**

| Method | Description |
|--------|-------------|
| `appendText(delta)` | Appends a text delta to the current text segment |
| `appendReasoning(delta)` | Appends a reasoning delta, styled as dim/italic |

---

### `BaseToolCallView`

A `Container` subclass that renders a single tool call — its name, streaming input JSON, and final output or error. Supports custom renderers via `ToolRendererMap`.

```typescript
import { BaseToolCallView, type ToolRendererMap } from "@ai-sdk-tool/tui";

// Custom renderer for a specific tool
const toolRenderers: ToolRendererMap = {
  read_file: (view, input, output) => {
    const path = (input as { path: string }).path;
    view.setRenderedOverride(`read: ${path}`);
  },
  shell_execute: (view, input) => {
    const cmd = (input as { command: string }).command;
    view.setRenderedOverride(`$ ${cmd}`);
  },
};

await createAgentTUI({ agent, messageHistory, toolRenderers });
```

**`ToolRendererMap` type:**

```typescript
interface ToolRendererMap {
  [toolName: string]: (
    view: BaseToolCallView,
    input: unknown,
    output: unknown
  ) => void;
}
```

---

### `Spinner`

A braille-frame spinner for non-TUI contexts — useful in headless scripts or CLI tools that want visual feedback without a full TUI.

```typescript
import { Spinner, setSpinnerOutputEnabled } from "@ai-sdk-tool/tui";

// Suppress spinner in tests or piped output
setSpinnerOutputEnabled(false);

const spinner = new Spinner("Processing...");
spinner.start();

try {
  await doWork();
  spinner.succeed("Done!");
} catch (err) {
  spinner.fail("Failed.");
}
```

**Methods:**

| Method | Description |
|--------|-------------|
| `start()` | Starts the animation |
| `stop()` | Stops and clears the spinner line |
| `succeed(message?)` | Stops and prints `✓ message` |
| `fail(message?)` | Stops and prints `✗ message` |

**Note:** Do not use `Spinner` inside a live TUI session — the TUI manages its own loader widget.

---

### `colors` and `colorize`

ANSI color constants and a helper for applying them.

```typescript
import { colors, colorize } from "@ai-sdk-tool/tui";

// Using the helper
const text = colorize("cyan", "important");
// => "\u001b[96mimportant\u001b[0m"

// Using constants directly
const styled = `${colors.bold}${colors.green}Success${colors.reset}`;
```

**Available color keys:**

`blue`, `yellow`, `green`, `cyan`, `red`, `magenta`, `white`, `brightBlue`, `brightGreen`, `brightYellow`, `brightCyan`, `brightMagenta`, `dim`, `bold`, `italic`, `underline`, `gray`, `reset`

---

## Advanced Usage

### Custom theme

```typescript
import { createAgentTUI } from "@ai-sdk-tool/tui";
import type { MarkdownTheme } from "@mariozechner/pi-tui";

const markdownTheme: MarkdownTheme = {
  heading: (text) => `\x1b[1m\x1b[33m${text}\x1b[0m`,
  code: (text) => `\x1b[32m${text}\x1b[0m`,
  // ... other theme fields
};

await createAgentTUI({ agent, messageHistory, theme: { markdownTheme } });
```

### Setup hook for dynamic header

```typescript
let modelName = "loading...";

await createAgentTUI({
  agent,
  messageHistory,
  header: {
    title: "My Agent",
    get subtitle() { return `model: ${modelName}`; },
  },
  onSetup: async () => {
    modelName = await fetchCurrentModel();
  },
});
```

### Registering custom slash commands

```typescript
import { registerCommand } from "@ai-sdk-tool/harness";
import { createAgentTUI } from "@ai-sdk-tool/tui";

registerCommand({
  name: "model",
  description: "Switch the active model",
  aliases: ["m"],
  execute: async ({ args }) => {
    const newModel = args[0];
    // ... switch model logic
    return { success: true, message: `Switched to ${newModel}` };
  },
});

await createAgentTUI({ agent, messageHistory });
```

## License

MIT
