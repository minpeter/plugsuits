# Code Editing Agent

A code-editing agent built with Vercel AI SDK and FriendliAI provider, following the architecture described in [ampcode.com/how-to-build-an-agent](https://ampcode.com/how-to-build-an-agent).

## Features

- **read_file**: Read the contents of a file
- **list_files**: List files and directories recursively
- **edit_file**: Edit files by string replacement, or create new files

## Requirements

- Node.js >= 18
- FriendliAI API token

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Set your FriendliAI token:

```bash
export FRIENDLI_TOKEN=your_token_here
```

3. Run the agent:

```bash
pnpm start
```

## Usage

```
$ pnpm start

Chat with Claude (use 'ctrl-c' to quit)

You: what's in package.json?
tool: read_file({"path":"package.json"})
Claude: The package.json file contains...

You: create a hello.js file that prints "Hello World"
tool: edit_file({"path":"hello.js","old_str":"","new_str":"console.log('Hello World');"})
Claude: I've created hello.js...

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
│   ├── tools/
│   │   ├── index.ts       # Tool exports
│   │   ├── read-file.ts   # File reading tool
│   │   ├── list-files.ts  # Directory listing tool
│   │   └── edit-file.ts   # File editing tool
│   └── utils/
│       └── colors.ts      # ANSI color output utilities
```

## Model

Uses `LGAI-EXAONE/K-EXAONE-236B-A23B` via FriendliAI serverless endpoints.

## License

MIT
