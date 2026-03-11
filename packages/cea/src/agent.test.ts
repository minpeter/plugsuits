import { beforeEach, describe, expect, it } from "bun:test";
import {
  computeSpeculativeStartRatio,
  MessageHistory,
} from "@ai-sdk-tool/harness";
import { agentManager, selectTranslationReasoningMode } from "./agent";

describe("AgentManager translation state", () => {
  beforeEach(() => {
    agentManager.resetForTesting();
  });
  it("enables translation by default", () => {
    expect(agentManager.isTranslationEnabled()).toBe(true);
  });

  it("toggles translation state on and off", () => {
    agentManager.setTranslationEnabled(false);
    expect(agentManager.isTranslationEnabled()).toBe(false);

    agentManager.setTranslationEnabled(true);
    expect(agentManager.isTranslationEnabled()).toBe(true);
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
  beforeEach(() => {
    agentManager.resetForTesting();
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

describe("AgentManager compaction config", () => {
  beforeEach(() => {
    agentManager.resetForTesting();
  });

  it("uses dynamically computed speculative ratio based on context and reserve", () => {
    agentManager.setProvider("friendli");
    agentManager.setModelId("test-compact");

    const compaction = agentManager.buildCompactionConfig();
    const contextLength = agentManager.getModelTokenLimits().contextLength;
    const history = new MessageHistory({ compaction });
    history.setContextLimit(contextLength);
    history.addUserMessage("hello");

    const expectedRatio = computeSpeculativeStartRatio(
      contextLength,
      compaction.reserveTokens
    );

    expect(compaction.maxTokens).toBe(20_480);
    expect(agentManager.getModelTokenLimits().maxCompletionTokens).toBe(20_480);
    expect(compaction.reserveTokens).toBe(512);
    expect(compaction.keepRecentTokens).toBe(Math.floor(20_480 * 0.3));
    expect(compaction.speculativeStartRatio).toBe(expectedRatio);
    expect(expectedRatio).toBeCloseTo(0.775, 3);

    history.updateActualUsage({ totalTokens: 16_000 });
    expect(history.shouldStartSpeculativeCompactionForNextTurn()).toBe(true);
    expect(history.needsCompaction()).toBe(false);
  });
});
