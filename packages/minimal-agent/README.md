# Minimal Agent

Minimal FriendliAI-backed example agent built on the workspace packages.

## Requirements

- Node.js 22+
- pnpm 10+
- `FRIENDLI_TOKEN`

Optional:

- `FRIENDLI_BASE_URL`
- `FRIENDLI_MODEL`

## Scripts

From the workspace root:

```bash
pnpm --filter @plugsuits/minimal-agent dev
pnpm --filter @plugsuits/minimal-agent build
pnpm --filter @plugsuits/minimal-agent start
```

## Workflows

Run from source in watch mode during development:

```bash
pnpm --filter @plugsuits/minimal-agent dev
```

Build and run the compiled output:

```bash
pnpm --filter @plugsuits/minimal-agent build
pnpm --filter @plugsuits/minimal-agent start
```

Run in headless mode with a prompt:

```bash
pnpm --filter @plugsuits/minimal-agent start -- --prompt "Summarize this repository"
```
