# plugsuits

## 2.3.1

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

## 2.3.0

### Minor Changes

- 2f62589: Prevent infinite compaction loops in small-context scenarios. Adds a per-turn compaction cap (`maxAcceptedCompactionsPerTurn`, default 10), relaxes the compaction acceptance gate to reject only on `fitsBudget` failures, and introduces opt-in task-aware 2-step compaction (enabled in CEA) that extracts the current user turn's task intent before summarizing to preserve the work context. Turn boundaries are now tracked via `notifyNewUserTurn()` called from TUI and headless runtime.

### Patch Changes

- 2f62589: Silence unhandled rejections in `buildAgentStreamWithTodoContinuation`. The todo-continuation wrapper creates new promise chains via async IIFEs and `.then()` derivations that fan out from `stream.finishReason`. When the base stream rejects (for example with `NoOutputGeneratedError`), callers that don't await every branch of the fan-out would previously crash the process with an unhandled rejection. Adds no-op `.catch()` guards on `continuationDecision`, `response`, and `finishReason` while still returning the same promise instances so actual awaiters continue to receive rejections.
- Updated dependencies [2f62589]
- Updated dependencies [2f62589]
  - @ai-sdk-tool/harness@1.2.1
  - @ai-sdk-tool/tui@3.0.1
  - @ai-sdk-tool/headless@3.0.1

## 2.2.1

### Patch Changes

- 828b5dd: Fix `pss --version` returning stale hardcoded version. Now reads version dynamically from package.json at runtime.

## 2.2.0

### Minor Changes

- 18bfebb: Migrate token usage naming from `promptTokens`/`completionTokens` to `inputTokens`/`outputTokens` to align with Vercel AI SDK v6.

  Fix model-agnostic compaction bug: prevent `totalTokens` from being misattributed as `promptTokens` when the provider omits prompt token counts. Invalidate stale `actualUsage` after message changes and compaction.

  Remove compact-test model entry — use `COMPACTION_DEBUG=1 CONTEXT_LIMIT_OVERRIDE=<N>` to simulate small context windows on any model.

### Patch Changes

- Updated dependencies [18bfebb]
  - @ai-sdk-tool/harness@1.2.0
  - @ai-sdk-tool/headless@3.0.0
  - @ai-sdk-tool/tui@3.0.0

## 2.1.3

### Patch Changes

- 5fb0fa6: fix: force zod v4 resolution via overrides to prevent runtime crash

## 2.1.2

### Patch Changes

- 9ba8e20: fix: add .js extensions to ESM imports for Node.js compatibility
- Updated dependencies [9ba8e20]
  - @ai-sdk-tool/harness@1.1.1
  - @ai-sdk-tool/headless@2.0.1
  - @ai-sdk-tool/tui@2.0.1

## 2.1.1

### Patch Changes

- 5aaef15: fix: publish @ai-sdk-tool/headless and @ai-sdk-tool/tui to npm

  Initial major release of headless and tui packages to npm registry.
  Republish plugsuits with corrected dependency versions.

- Updated dependencies [5aaef15]
  - @ai-sdk-tool/headless@2.0.0
  - @ai-sdk-tool/tui@2.0.0

## 2.1.0

### Minor Changes

- 5a8b087: feat: decouple shared runtimes and simplify context footer text

  - split the shared harness, terminal UI, and headless runner into reusable workspace packages with expanded session, command, and compaction infrastructure
  - unify the `plugsuits` CLI around the shared runtimes, improve `/compact` behavior, and make file read failures more actionable
  - remove the `Context:` prefix from footer-style context usage displays so the TUI shows a cleaner token summary across agents

- 618d458: refactor: ship the segment-first compaction system across the shared runtimes

  - move harness compaction onto segment-based state and prepared artifacts
  - share compaction orchestration across TUI and headless runtimes
  - guard CEA model calls from empty prepared message lists under tight context budgets

### Patch Changes

- Updated dependencies [badc5c7]
- Updated dependencies [5a8b087]
- Updated dependencies [618d458]
  - @ai-sdk-tool/harness@1.1.0
  - @ai-sdk-tool/tui@1.0.0
  - @ai-sdk-tool/headless@1.0.0

## 1.1.3

### Patch Changes

- 2f41927: Render tool errors with pretty formatted backgrounds instead of falling back to raw generic output. Applies to read_file, glob_files, grep_files, shell_execute, shell_interact, write_file, edit_file, delete_file, skill_execute, and todo_write tools.
- Updated dependencies [2f41927]
  - @ai-sdk-tool/harness@0.3.1

## 1.1.2

### Patch Changes

- Updated dependencies [902ded6]
  - @ai-sdk-tool/harness@0.3.0

## 1.1.1

### Patch Changes

- 7b381a7: Fix Ctrl+C double-press exit not working after a conversation due to lingering AI SDK HTTP connections keeping the event loop alive. Simplify Ctrl+C handling to match pi-coding-agent: first press clears editor, second press within 500ms exits. Remove pendingExitConfirmation state machine and force process.exit after cleanup.
- af6223c: Fix empty Enter (blank input) causing the app to exit instead of being silently ignored, matching pi-coding-agent behavior.

## 1.1.0

### Minor Changes

- 143d11b: Headless mode improvements: skip translation for system-generated messages, add --max-iterations flag for CI safety, improve stream response error handling

### Patch Changes

- 85b32c7: fix(architecture): add createAgentManager factory and use instance provider clients

  Adds `createAgentManager()` factory function to `agent.ts` for test isolation
  and multi-agent support. The factory creates fresh provider clients from the
  provided options (or falls back to environment variables), enabling independent
  AgentManager instances with different credentials or base URLs.

  `AgentManager` now accepts optional provider clients in its constructor and uses
  them via a private `getProviderModel()` method instead of the module-level
  closures, enabling proper isolation between instances.

  The module-level `agentManager` singleton is preserved for backward compatibility.

  Closes #33
  Closes #43

- af700c8: Handle compound commands in noninteractive wrapper — skip suffix arg injection for piped and chained commands to prevent incorrect command corruption
- b540a60: Fix .env.example to match actual env vars, add startup provider validation, and support custom base URLs for provider endpoints
- f658135: Prevent PID recycling race in killProcessTree by checking activeProcesses before SIGKILL and clearing timeout in finish()
- 9b02b57: fix(security): add path containment and result limit to glob tool

  Prevents symlink traversal outside the search directory by resolving
  each matched file with `realpath()` and verifying containment. Files
  that resolve outside `searchDir` (via symlinks) are silently excluded.
  Broken symlinks are also silently skipped. Adds a 10,000-candidate
  scan limit before the stat phase to bound computational work, reported
  as `glob_limit_reached` in the output.

- 6b05ce0: Move session todo files to system temp directory to prevent project pollution, reset edit-failure tracking maps when conversation is cleared
- Updated dependencies [1f1f77d]
- Updated dependencies [cabecaf]
  - @ai-sdk-tool/harness@0.2.1

## 1.0.2

### Patch Changes

- Updated dependencies [b519c2a]
  - @ai-sdk-tool/harness@0.2.0

## 1.0.1

### Patch Changes

- 62b4261: Set up Changesets-based release automation for the monorepo.
  Add the `pss` CLI alias for `plugsuits` and switch internal harness dependency to a publish-safe semver range.
- Updated dependencies [62b4261]
  - @ai-sdk-tool/harness@0.1.1
