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

- Node.js >= 22
- pnpm >= 10
- A [FriendliAI](https://friendli.ai) API token (or any Vercel AI SDK-compatible provider)

### Run directly

```bash
export FRIENDLI_TOKEN=your_token_here
pnpm dlx plugsuits
```

### Local development

```bash
git clone https://github.com/minpeter/plugsuits.git
cd plugsuits
pnpm install
pnpm dev
```

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
  /model      Switch AI models
  /reasoning  Toggle reasoning mode
  /translate  Toggle translation mode
  /render     Render raw prompt
  /quit       Exit
```

### Headless mode

```bash
pnpm run headless -- "Fix the type error in src/index.ts"
```

Outputs structured JSONL events (`user`, `tool_call`, `tool_result`, `assistant`, `error`) for programmatic consumption.

## Architecture

```
plugsuits/
├── packages/
│   ├── harness/              @ai-sdk-tool/harness
│   │   └── src/              Core agent loop, message history, tool management
│   │
│   └── cea/                  @ai-sdk-tool/cea
│       ├── src/
│       │   ├── entrypoints/  CLI (interactive) + headless (JSONL) runtimes
│       │   ├── tools/
│       │   │   ├── modify/   edit_file (hashline engine), write_file, delete_file
│       │   │   ├── explore/  read_file, grep, glob
│       │   │   └── execute/  shell_execute, shell_interact
│       │   └── interaction/  TUI renderer, streaming, spinner
│       └── benchmark/        Harbor terminal-bench adapter
│
└── scripts/                  Benchmark and test automation
```

### Packages

| Package | Description |
|---------|-------------|
| [`@ai-sdk-tool/harness`](./packages/harness) | Reusable agent harness — model-agnostic loop, tool management, message history |
| [`@ai-sdk-tool/cea`](./packages/cea) | Code editing agent — full implementation with TUI, tools, and FriendliAI integration |

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
COMPACTION_DEBUG=1 CONTEXT_LIMIT_OVERRIDE=32768 pnpm -F plugsuits dev -- -m zai-org/GLM-5
```

`COMPACTION_DEBUG=1` enables:
- `[compaction-debug]` logs on stderr showing `needsCompaction`, `speculative?`, and `checkAndCompact` decisions each turn
- `CONTEXT_LIMIT_OVERRIDE` support — forces the context limit to the given value regardless of the model's actual limit, useful for triggering compaction with fewer messages

Both the TUI footer and the compaction engine will reflect the overridden limit. `CONTEXT_LIMIT_OVERRIDE` has no effect without `COMPACTION_DEBUG=1`.

## Built With

- [Vercel AI SDK](https://sdk.vercel.ai) — Model provider abstraction and streaming
- [FriendliAI](https://friendli.ai) — Default model provider
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
