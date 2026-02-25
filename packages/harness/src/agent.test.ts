import { describe, expect, it } from "bun:test";
import { createAgent } from "./agent";
import type { AgentConfig } from "./types";

function createMockModel(): AgentConfig["model"] {
  return {} as AgentConfig["model"];
}

describe("createAgent", () => {
  it("returns an agent with config and stream method", () => {
    const model = createMockModel();
    const agent = createAgent({ model });

    expect(agent).toHaveProperty("config");
    expect(agent).toHaveProperty("stream");
    expect(typeof agent.stream).toBe("function");
  });

  it("preserves provided config values", () => {
    const model = createMockModel();
    const config: AgentConfig = {
      model,
      instructions: "You are a harness test agent.",
      maxStepsPerTurn: 5,
    };

    const agent = createAgent(config);

    expect(agent.config.model).toBe(model);
    expect(agent.config.instructions).toBe("You are a harness test agent.");
    expect(agent.config.maxStepsPerTurn).toBe(5);
  });

  it("keeps maxStepsPerTurn undefined when omitted", () => {
    const agent = createAgent({ model: createMockModel() });

    expect(agent.config.maxStepsPerTurn).toBeUndefined();
  });
});
