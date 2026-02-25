import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

  it("selects preserved as default for GLM-5", () => {
    agentManager.setProvider("friendli");
    agentManager.setModelId("zai-org/GLM-5");

    expect(agentManager.getReasoningMode()).toBe("preserved");
  });

  it("selects interleaved as default for MiniMax M2.5", () => {
    agentManager.setProvider("friendli");
    agentManager.setModelId("MiniMaxAI/MiniMax-M2.5");

    expect(agentManager.getReasoningMode()).toBe("interleaved");
  });

  it("selects on as default for anthropic models", () => {
    agentManager.setProvider("anthropic");

    expect(agentManager.getReasoningMode()).toBe("on");
  });

  it("still allows explicit override after default selection", () => {
    agentManager.setProvider("friendli");
    agentManager.setModelId("MiniMaxAI/MiniMax-M2.5");
    agentManager.setReasoningMode("on");

    expect(agentManager.getReasoningMode()).toBe("on");
  });
});
