import {
  CheckpointHistory,
  type createModelSummarizer,
} from "@ai-sdk-tool/harness";
import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentManager,
  buildFileTrackingSummarizeFn,
  computeAdaptiveThresholdRatio,
  computeCompactionMaxTokens,
  computeSpeculativeStartRatio,
  selectTranslationReasoningMode,
} from "./agent";

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

  it("buildFileTrackingSummarizeFn injects read/modified files into summary", async () => {
    const modelSummarizer = vi.fn(
      async (_messages: ModelMessage[], previousSummary?: string) =>
        previousSummary ? `${previousSummary} :: summary` : "summary"
    );
    const { summarizeFn } = buildFileTrackingSummarizeFn(modelSummarizer);
    const firstMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read-1",
            toolName: "read_file",
            input: { path: "packages/cea/src/agent.ts" },
          },
          {
            type: "tool-call",
            toolCallId: "write-1",
            toolName: "write_file",
            input: { path: "packages/cea/src/agent.test.ts" },
          },
          {
            type: "tool-call",
            toolCallId: "delete-1",
            toolName: "delete_file",
            input: { path: "packages/cea/src/unused.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-1",
            toolName: "read_file",
            output: "file contents",
          },
        ],
      },
    ] as ModelMessage[];

    const firstSummary = await summarizeFn(firstMessages, "previous summary");

    expect(modelSummarizer).toHaveBeenCalledWith(
      firstMessages,
      "previous summary"
    );
    expect(firstSummary).toBe(`<read-files>
packages/cea/src/agent.ts
</read-files>

<modified-files>
packages/cea/src/agent.test.ts, packages/cea/src/unused.ts
</modified-files>

previous summary :: summary`);

    const secondMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read-2",
            toolName: "read_file",
            input: { path: "packages/harness/src/checkpoint-history.ts" },
          },
        ],
      },
    ] as ModelMessage[];

    const secondSummary = await summarizeFn(secondMessages);

    expect(secondSummary).toBe(`<read-files>
packages/cea/src/agent.ts, packages/harness/src/checkpoint-history.ts
</read-files>

<modified-files>
packages/cea/src/agent.test.ts, packages/cea/src/unused.ts
</modified-files>

summary`);
  });

  it("computeAdaptiveThresholdRatio returns context-adapted values", () => {
    expect(computeAdaptiveThresholdRatio(8000)).toBe(0.45);
    expect(computeAdaptiveThresholdRatio(16_000)).toBe(0.45);
    expect(computeAdaptiveThresholdRatio(20_000)).toBe(0.5);
    expect(computeAdaptiveThresholdRatio(32_000)).toBe(0.5);
    expect(computeAdaptiveThresholdRatio(40_000)).toBe(0.55);
    expect(computeAdaptiveThresholdRatio(64_000)).toBe(0.55);
    expect(computeAdaptiveThresholdRatio(80_000)).toBe(0.6);
    expect(computeAdaptiveThresholdRatio(128_000)).toBe(0.6);
    expect(computeAdaptiveThresholdRatio(200_000)).toBe(0.65);
    expect(computeAdaptiveThresholdRatio(400_000)).toBe(0.65);
    expect(computeAdaptiveThresholdRatio(0)).toBe(0.5);
  });

  it("uses a soft compaction threshold and earlier speculative ratio based on usable input budget", () => {
    agentManager.setProvider("friendli");
    agentManager.setModelId("test-compact");

    const mutableAgentManager = agentManager as unknown as {
      getProviderModel(
        modelId: string,
        provider: string
      ): Parameters<typeof createModelSummarizer>[0];
    };
    mutableAgentManager.getProviderModel = () => ({}) as never;

    const compaction = agentManager.buildCompactionConfig();
    const contextLength = agentManager.getModelTokenLimits().contextLength;
    const history = new CheckpointHistory({ compaction });
    history.setContextLimit(contextLength);
    history.addUserMessage("hello");

    const expectedRatio = computeSpeculativeStartRatio(
      contextLength,
      compaction.reserveTokens ?? 0
    );
    const expectedMaxTokens = computeCompactionMaxTokens(
      contextLength,
      compaction.reserveTokens ?? 0
    );
    const expectedThresholdRatio = computeAdaptiveThresholdRatio(contextLength);

    expect(compaction.maxTokens).toBe(expectedMaxTokens);
    expect(compaction.thresholdRatio).toBe(expectedThresholdRatio);
    expect(agentManager.getModelTokenLimits().maxCompletionTokens).toBe(20_480);
    expect(compaction.reserveTokens).toBe(2048);
    expect(compaction.keepRecentTokens).toBe(
      Math.min(
        Math.floor(contextLength * 0.3),
        Math.max(512, Math.floor(contextLength * expectedThresholdRatio * 0.3))
      )
    );
    expect(compaction.speculativeStartRatio).toBe(expectedRatio);
    expect(expectedRatio).toBeCloseTo(0.75, 2);

    history.updateActualUsage({
      totalTokens: 16_000,
      promptTokens: 16_000,
      completionTokens: 0,
      updatedAt: new Date(),
    });
    expect(history.shouldStartSpeculativeCompactionForNextTurn()).toBe(true);
    expect(history.needsCompaction()).toBe(true);
  });

  it("fails fast with a clear error when stream is called with empty messages", async () => {
    await expect(agentManager.stream([])).rejects.toThrow(
      "Cannot call the model with an empty message list after context preparation."
    );
  });

  it("buildCompactionConfig includes getStructuredState callback", () => {
    agentManager.setProvider("friendli");
    agentManager.setModelId("test-compact");

    const mutableAgentManager = agentManager as unknown as {
      getProviderModel(
        modelId: string,
        provider: string
      ): Parameters<typeof createModelSummarizer>[0];
    };
    mutableAgentManager.getProviderModel = () => ({}) as never;

    const config = agentManager.buildCompactionConfig();
    expect(typeof config.getStructuredState).toBe("function");
    const state = config.getStructuredState?.();
    expect(state === undefined || typeof state === "string").toBe(true);
  });
});
