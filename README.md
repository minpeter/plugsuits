<div align="center">

<img src="./assets/banner.jpg" alt="plugsuits" width="100%" />

# plugsuits

**プラグスーツ**

*Plug and go, native like a suit.*

A barebone AI agent harness built on the [Vercel AI SDK](https://sdk.vercel.ai).

[Getting Started](#quick-start) · [Architecture](#architecture) · [Development](#development)

</div>

---

## What is plugsuits?

In *Neon Genesis Evangelion*, a **plugsuit** is the neural interface between a pilot and their Evangelion — form-fitting, minimal, and essential. Without it, synchronization doesn't happen.

**plugsuits** takes the same approach to AI agents. A lightweight TypeScript harness that connects any LLM to code editing, file operations, and shell execution — with nothing more than what's needed.

No framework overhead. No abstraction tax. Just the interface between model and tools.

## Features

- **Any model, any provider** — Drop in models via Vercel AI SDK's unified provider ecosystem
- **Hashline edit engine** — Deterministic file editing with hash-verified line anchors and autocorrect
- **Interactive TUI** — Full terminal UI with streaming, syntax highlighting, and runtime model switching
- **Headless mode** — JSONL event streaming for CI/CD, benchmarks, and automation
- **Tool harness** — File read/write/edit, glob, grep, shell execution — batteries included
- **Repair escalation** — Progressive error recovery for weaker models (validate → auto-repair → lenient fallback)
- **Monorepo** — Clean separation between the harness core and the agent implementation

## Quick Start

### Prerequisites

- Node.js >= 18
- pnpm >= 10
- An API key for your chosen AI gateway/provider

### Run directly

```bash
export AI_API_KEY=your_api_key_here
# Optional shared overrides
export AI_BASE_URL=https://your-openai-compatible-endpoint.example/v1
export AI_MODEL=your-model-id
export AI_CONTEXT_LIMIT=128000
pnpm dlx plugsuits
```

### Local development

```bash
git clone https://github.com/minpeter/plugsuits.git
cd plugsuits
pnpm install
pnpm dev
```

### Shared AI configuration

`packages/cea` and `packages/tgbot` now use the same minimal-agent-style AI
configuration surface:

- `AI_API_KEY` — required credential for the configured model gateway/provider
- `AI_BASE_URL` — optional OpenAI-compatible base URL override
- `AI_MODEL` — optional model ID override
- `AI_CONTEXT_LIMIT` — optional context window override for compaction-aware runtimes

`packages/tgbot` still requires its Telegram- and Redis-specific settings in
addition to the shared `AI_*` variables above.

## Usage

### Interactive mode

```
$ pnpm dev

Chat with AI (model: LGAI-EXAONE/K-EXAONE-236B-A23B)
Use '/help' for commands, 'ctrl-c' to quit

You: what files are in the src directory?
tool: read_file({"path":"src"})
AI: Here's what's in the src directory...

You: /help
Available commands:
  /help       Show this help message
  /clear      Clear conversation
  /reasoning-mode  Set reasoning mode
  /translate  Toggle translation mode
  /quit       Exit
```

### Headless mode

```bash
pnpm run headless -- "Fix the type error in src/index.ts"
```

Outputs structured ATIF JSONL events (`metadata`, `step`, `approval`, `compaction`, `error`, `interrupt`) for programmatic consumption.

## Architecture

```
plugsuits/
├── packages/
│   ├── harness/              @ai-sdk-tool/harness
│   │   └── src/              Core agent loop, message history, tool management
│   │
│   ├── tui/                  @ai-sdk-tool/tui
│   │   └── src/              Interactive terminal UI runtime and stream rendering
│   │
│   ├── headless/             @ai-sdk-tool/headless
│   │   └── src/              ATIF JSONL runner and trajectory persistence
│   │
│   ├── cea/                  @ai-sdk-tool/cea
│   │   ├── src/
│   │   │   ├── entrypoints/  CLI/bootstrap wiring for interactive + headless runs
│   │   │   ├── tools/
│   │   │   │   ├── modify/   edit_file (hashline engine), write_file, delete_file
│   │   │   │   ├── explore/  read_file, grep, glob
│   │   │   │   └── execute/  shell_execute, shell_interact
│   │   │   └── interaction/  CEA-specific interaction/rendering adapters
│   │   └── benchmark/        Harbor terminal-bench adapter
│   │
│   └── tgbot/                @plugsuits/tgbot
│       └── src/              Telegram bot runtime sharing the AI_* config surface
│
└── scripts/                  Benchmark and test automation
```

### Packages

| Package | Description |
|---------|-------------|
| [`@ai-sdk-tool/harness`](./packages/harness) | Reusable agent harness — model-agnostic loop, tool management, message history |
| [`@ai-sdk-tool/tui`](./packages/tui) | Interactive terminal UI runtime and stream rendering primitives |
| [`@ai-sdk-tool/headless`](./packages/headless) | ATIF JSONL runner and persisted trajectory generation for automation |
| [`@ai-sdk-tool/cea`](./packages/cea) | Code editing agent — full implementation with TUI, tools, and shared AI_* configuration |
| [`@plugsuits/tgbot`](./packages/tgbot) | Telegram bot runtime sharing the same minimal-agent-style AI_* configuration surface |

## Development

```bash
pnpm install         # Install dependencies
pnpm dev             # Interactive TUI (source mode)
pnpm run headless -- "Fix the bug"  # Headless JSONL mode
pnpm test            # Run all tests
pnpm run typecheck   # Type check all packages
pnpm run check       # Lint — non-mutating
pnpm run lint        # Lint — auto-fix
pnpm run build       # Build (harness → cea)
```

## Debugging

### Compaction debugging

The context compaction system can be debugged by setting environment variables:

```bash
# Enable compaction debug logging (stderr)
COMPACTION_DEBUG=1 pnpm dev

# Override the context limit to simulate a smaller context window
CONTEXT_LIMIT_OVERRIDE=32768 pnpm -F plugsuits dev -- -m zai-org/GLM-5
```

`COMPACTION_DEBUG=1` enables `[compaction-debug]` logs on stderr showing `needsCompaction`, `speculative?`, and `checkAndCompact` decisions each turn.

`CONTEXT_LIMIT_OVERRIDE` works independently and forces the context limit to the given value regardless of the model's actual limit. Both the TUI footer and the compaction engine will reflect the overridden limit.

## Built With

- [Vercel AI SDK](https://sdk.vercel.ai) — Model provider abstraction and streaming
- OpenAI-compatible gateways/providers via shared `AI_*` runtime configuration
- [pnpm](https://pnpm.io) — Workspace package manager
- [Turborepo](https://turbo.build/repo) — Task orchestration and caching
- [TypeScript](https://www.typescriptlang.org) — Strict mode throughout

## License

MIT

---

<p align="center">
  <sub>
    The name <b>plugsuits</b> was suggested by <a href="mailto:seojoon.kim@gmail.com">Simon Kim</a> of <a href="https://www.hashed.com">Hashed</a>.
    <br/>
    <i>"Plug and go, native like a suit"</i> — like a plugsuit synchronizing a pilot with their Eva,
    <br/>
    this harness synchronizes AI models with the tools they need.
  </sub>
</p>
