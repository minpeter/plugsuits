import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { agentManager, selectTranslationReasoningMode } from "./agent";

describe("AgentManager translation state", () => {
  it("enables translation by default", () => {
    expect(agentManager.isTranslationEnabled()).toBe(true);
  });

  it("toggles translation state on and off", () => {
    const originalState = agentManager.isTranslationEnabled();

    try {
      agentManager.setTranslationEnabled(false);
      expect(agentManager.isTranslationEnabled()).toBe(false);

      agentManager.setTranslationEnabled(true);
      expect(agentManager.isTranslationEnabled()).toBe(true);
    } finally {
      agentManager.setTranslationEnabled(originalState);
    }
  });
});

describe("selectTranslationReasoningMode", () => {
  it("prefers off when available", () => {
    expect(selectTranslationReasoningMode(["preserved", "off", "on"])).toBe(
      "off"
    );
  });

  it("falls back to on when off is unavailable", () => {
    expect(selectTranslationReasoningMode(["interleaved", "on"])).toBe("on");
  });
});

describe("AgentManager translation reasoning selection", () => {
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

  it("uses off for translation when off is selectable", () => {
    agentManager.setProvider("friendli");
    agentManager.setModelId("zai-org/GLM-5");
    agentManager.setReasoningMode("preserved");

    expect(agentManager.getTranslationReasoningMode()).toBe("off");
  });

  it("uses on for translation when off is unavailable", () => {
    agentManager.setProvider("friendli");
    agentManager.setModelId("MiniMaxAI/MiniMax-M2.5");
    agentManager.setReasoningMode("interleaved");

    expect(agentManager.getTranslationReasoningMode()).toBe("on");
  });
});
