# Minimal Agent

Minimal Anthropic-backed example agent built on the workspace packages.

## Requirements

- Node.js 22+
- pnpm 10+
- `ANTHROPIC_API_KEY`

Optional:
- none

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
