# Code Editing Agent

A code-editing agent built with Vercel AI SDK and FriendliAI provider, following the architecture described in [ampcode.com/how-to-build-an-agent](https://ampcode.com/how-to-build-an-agent).

## Requirements

- [Bun](https://bun.sh) >= 1.0
- FriendliAI API token

## Installation

### Quick Start (via bunx)

Run directly without installation:

```bash
export FRIENDLI_TOKEN=your_token_here
bunx github:minpeter/agent#main
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

## Usage

```
$ bun start

Chat with AI (model: LGAI-EXAONE/K-EXAONE-236B-A23B)
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
  /model             - Show and select available AI models
  /render            - Render conversation as raw prompt text
  /quit              - Exit the program

You: ^C
```

## Architecture

The agent uses the Vercel AI SDK's `streamText` API with `stopWhen: stepCountIs(n)` for step control. This replaces the older `maxSteps` / `continueUntil` pattern—`stepCountIs` provides a clearer, declarative way to limit tool-call round-trips (e.g., `stepCountIs(1)` allows one tool invocation cycle per stream call). The outer conversation loop in the CLI drives multi-turn interaction.

## Model

Uses `LGAI-EXAONE/K-EXAONE-236B-A23B` via FriendliAI serverless endpoints by default. Use `/model` command to switch models.

## License

MIT
