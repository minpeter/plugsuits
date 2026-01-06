# Code Editing Agent

A code-editing agent built with Vercel AI SDK and FriendliAI provider, following the architecture described in [ampcode.com/how-to-build-an-agent](https://ampcode.com/how-to-build-an-agent).

## Features

- **read_file**: Read the contents of a file
- **list_files**: List files and directories recursively
- **edit_file**: Edit files by string replacement, or create new files
- **run_command**: Execute safe shell commands

## Requirements

- [Bun](https://bun.sh) >= 1.0
- FriendliAI API token

## Installation

### Quick Start (via bunx)

Run directly without installation:

```bash
export FRIENDLI_TOKEN=your_token_here
bunx github:minpeter/agent
```

### Global Installation

```bash
bun install -g github:minpeter/agent
export FRIENDLI_TOKEN=your_token_here
code-editing-agent
```

### Local Development

1. Clone the repository:

```bash
git clone https://github.com/minpeter/code-editing-agent.git
cd code-editing-agent
```

2. Install dependencies:

```bash
bun install
```

3. Set your FriendliAI token:

```bash
export FRIENDLI_TOKEN=your_token_here
```

4. Run the agent:

```bash
bun start
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FRIENDLI_TOKEN` | Yes | Your FriendliAI API token |
| `DEBUG_CHUNK_LOG` | No | Enable debug logging (`true`, `1`, `yes`, `on`) |

## Usage

```
$ bun start

Chat with AI (model: zai-org/GLM-4.6)
Use '/help' for commands, 'ctrl-c' to quit

You: what's in package.json?
tool: read_file({"path":"package.json"})
AI: The package.json file contains...

You: create a hello.js file that prints "Hello World"
tool: edit_file({"path":"hello.js","old_str":"","new_str":"console.log('Hello World');"})
AI: I've created hello.js...

You: /help
Available commands:
  /help              - Show this help message
  /clear             - Clear current conversation
  /save              - Save current conversation
  /load <id>         - Load a saved conversation
  /list              - List all saved conversations
  /delete <id>       - Delete a saved conversation
  /models            - List and select available AI models
  /render            - Render conversation as raw prompt text
  /quit              - Exit the program

You: ^C
```

## Project Structure

```
code-editing-agent/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # CLI entry point
│   ├── agent.ts           # Agent class with conversation management
│   ├── env.ts             # Type-safe environment variables
│   ├── commands/
│   │   └── index.ts       # Slash command handlers
│   ├── middleware/
│   │   └── trim-leading-newlines.ts
│   ├── model/
│   │   └── create-model.ts
│   ├── prompts/
│   │   └── system.ts      # System prompt
│   ├── tools/
│   │   ├── index.ts       # Tool exports
│   │   ├── read-file.ts   # File reading tool
│   │   ├── list-files.ts  # Directory listing tool
│   │   ├── edit-file.ts   # File editing tool
│   │   └── run-command.ts # Command execution tool
│   └── utils/
│       ├── colors.ts      # ANSI color output utilities
│       ├── conversation-store.ts
│       ├── file-safety.ts
│       ├── model-selector.ts
│       └── retry.ts
```

## Model

Uses `zai-org/GLM-4.6` via FriendliAI serverless endpoints by default. Use `/models` command to switch models.

## License

MIT
