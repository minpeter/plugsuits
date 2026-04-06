---
"@ai-sdk-tool/harness": patch
"plugsuits": patch
"@plugsuits/minimal-agent": patch
---

Add MCP (Model Context Protocol) client integration and improve developer experience

- `createAgent()` now accepts an `mcp` option for automatic MCP tool loading
- `createAgent()` is now async and returns `Promise<Agent>`
- `Agent.close()` method added for MCP connection cleanup (no-op when no MCP configured)
- `MCPOption` supports four forms: `true` (load from `.mcp.json`), `MCPServerConfig[]` (inline servers), `{ config, servers }` (both), or a pre-initialized `MCPManager` instance
- MCPManager caching with reference counting — same config reuses existing connections
- Inline server arrays (`MCPServerConfig[]`) now correctly passed to MCPManager
- `MCPManagerOptions.servers` added for programmatic server injection
- Minimal agent wired with DuckDuckGo search MCP server
