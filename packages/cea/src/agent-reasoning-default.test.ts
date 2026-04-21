import { describe, expect, it } from "vitest";
import { AgentManager } from "./agent";

describe("AgentManager reasoning mode defaults", () => {
  it("selects on as default for configured AI models", () => {
    const agentManager = new AgentManager(null);
    agentManager.resetForTesting();

    expect(agentManager.getReasoningMode()).toBe("on");
  });

  it("still allows explicit override after default selection", () => {
    const agentManager = new AgentManager(null);
    agentManager.resetForTesting();
    agentManager.setReasoningMode("off");

    expect(agentManager.getReasoningMode()).toBe("off");
  });
});
