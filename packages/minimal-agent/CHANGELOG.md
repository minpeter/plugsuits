# @plugsuits/minimal-agent

## 0.2.5

### Patch Changes

- 6ce5711: Add MCP (Model Context Protocol) client integration and improve developer experience

  - `createAgent()` now accepts an `mcp` option for automatic MCP tool loading
  - `createAgent()` is now async and returns `Promise<Agent>`
  - `Agent.close()` method added for MCP connection cleanup (no-op when no MCP configured)
  - `MCPOption` supports four forms: `true` (load from `.mcp.json`), `MCPServerConfig[]` (inline servers), `{ config, servers }` (both), or a pre-initialized `MCPManager` instance
  - MCPManager caching with reference counting — same config reuses existing connections
  - Inline server arrays (`MCPServerConfig[]`) now correctly passed to MCPManager
  - `MCPManagerOptions.servers` added for programmatic server injection
  - Minimal agent wired with DuckDuckGo search MCP server

- Updated dependencies [6ce5711]
  - @ai-sdk-tool/harness@1.2.2
  - @ai-sdk-tool/headless@3.0.1
  - @ai-sdk-tool/tui@3.0.1

## 0.2.4

### Patch Changes

- Updated dependencies [2f62589]
- Updated dependencies [2f62589]
  - @ai-sdk-tool/harness@1.2.1
  - @ai-sdk-tool/tui@3.0.1
  - @ai-sdk-tool/headless@3.0.1

## 0.2.3

### Patch Changes

- Updated dependencies [18bfebb]
  - @ai-sdk-tool/harness@1.2.0
  - @ai-sdk-tool/headless@3.0.0
  - @ai-sdk-tool/tui@3.0.0

## 0.2.2

### Patch Changes

- Updated dependencies [9ba8e20]
  - @ai-sdk-tool/harness@1.1.1
  - @ai-sdk-tool/headless@2.0.1
  - @ai-sdk-tool/tui@2.0.1

## 0.2.1

### Patch Changes

- Updated dependencies [5aaef15]
  - @ai-sdk-tool/headless@2.0.0
  - @ai-sdk-tool/tui@2.0.0

## 0.2.0

### Minor Changes

- 5a8b087: feat: decouple shared runtimes and simplify context footer text

  - split the shared harness, terminal UI, and headless runner into reusable workspace packages with expanded session, command, and compaction infrastructure
  - unify the `plugsuits` CLI around the shared runtimes, improve `/compact` behavior, and make file read failures more actionable
  - remove the `Context:` prefix from footer-style context usage displays so the TUI shows a cleaner token summary across agents

### Patch Changes

- Updated dependencies [badc5c7]
- Updated dependencies [5a8b087]
- Updated dependencies [618d458]
  - @ai-sdk-tool/harness@1.1.0
  - @ai-sdk-tool/tui@1.0.0
  - @ai-sdk-tool/headless@1.0.0
