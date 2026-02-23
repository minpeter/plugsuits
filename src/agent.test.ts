import { describe, expect, it } from "bun:test";
import { agentManager } from "./agent";

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
