---
"plugsuits": patch
---

fix(architecture): add createAgentManager factory and use instance provider clients

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
