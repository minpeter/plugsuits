import type { DefinedAgent } from "./types";

/**
 * Declares an agent definition. Pure factory — no side effects, no I/O.
 * Pass the result to `createAgentRuntime` to create a runtime.
 */
export function defineAgent<TContext = unknown>(
  definition: Omit<DefinedAgent<TContext>, "kind">
): DefinedAgent<TContext> {
  if (!definition.name || definition.name.trim().length === 0) {
    throw new Error("defineAgent: name must not be empty");
  }
  if (!definition.agent) {
    throw new Error("defineAgent: agent must be provided");
  }
  return {
    ...definition,
    kind: "defined-agent",
  } as DefinedAgent<TContext>;
}

/** Type guard to check if an unknown value is a DefinedAgent. */
export function isDefinedAgent(value: unknown): value is DefinedAgent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).kind === "defined-agent" &&
    typeof (value as Record<string, unknown>).name === "string"
  );
}
