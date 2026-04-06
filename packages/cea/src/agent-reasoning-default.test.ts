import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentManager } from "./agent";

describe("AgentManager reasoning mode defaults", () => {
  let originalProvider: ReturnType<typeof agentManager.getProvider>;
  let originalModelId: ReturnType<typeof agentManager.getModelId>;
  let originalReasoningMode: ReturnType<typeof agentManager.getReasoningMode>;

  beforeEach(() => {
    originalProvider = agentManager.getProvider();
    originalModelId = agentManager.getModelId();
    originalReasoningMode = agentManager.getReasoningMode();
  });

  afterEach(() => {
    agentManager.setProvider(originalProvider);
    agentManager.setModelId(originalModelId);
    agentManager.setReasoningMode(originalReasoningMode);
  });

  it("selects on as default for anthropic models", () => {
    agentManager.setProvider("anthropic");

    expect(agentManager.getReasoningMode()).toBe("on");
  });

  it("still allows explicit override after default selection", () => {
    agentManager.setProvider("anthropic");
    agentManager.setReasoningMode("off");

    expect(agentManager.getReasoningMode()).toBe("off");
  });
});
