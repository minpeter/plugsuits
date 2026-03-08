# plugsuits

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
