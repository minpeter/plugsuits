import { describe, expect, it } from "bun:test";
import type { ProviderType } from "../agent";
import type { ReasoningMode } from "../reasoning-mode";
import type { ToolFallbackMode } from "../tool-fallback-mode";
import { applyHeadlessAgentConfig } from "./headless-agent-config";

interface CallRecord {
  args: unknown[];
  method: string;
}

const createRecorder = () => {
  const calls: CallRecord[] = [];

  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };

  return {
    calls,
    target: {
      setHeadlessMode: (enabled: boolean) => record("setHeadlessMode", enabled),
      setModelId: (modelId: string) => record("setModelId", modelId),
      setProvider: (provider: ProviderType) => record("setProvider", provider),
      setReasoningMode: (mode: ReasoningMode) =>
        record("setReasoningMode", mode),
      setToolFallbackMode: (mode: ToolFallbackMode) =>
        record("setToolFallbackMode", mode),
      setTranslationEnabled: (enabled: boolean) =>
        record("setTranslationEnabled", enabled),
    },
  };
};

describe("applyHeadlessAgentConfig", () => {
  it("does not overwrite provider default model when --model is omitted", () => {
    const { calls, target } = createRecorder();

    applyHeadlessAgentConfig(target, {
      provider: "anthropic",
      model: undefined,
      reasoningMode: null,
      toolFallbackMode: "disable",
      translateUserPrompts: true,
    });

    expect(calls.some((call) => call.method === "setModelId")).toBe(false);
    expect(calls).toContainEqual({
      method: "setProvider",
      args: ["anthropic"],
    });
  });

  it("applies explicit model when provided", () => {
    const { calls, target } = createRecorder();

    applyHeadlessAgentConfig(target, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      reasoningMode: "on",
      toolFallbackMode: "morphxml",
      translateUserPrompts: false,
    });

    expect(calls).toContainEqual({
      method: "setModelId",
      args: ["claude-sonnet-4-6"],
    });
    expect(calls).toContainEqual({
      method: "setReasoningMode",
      args: ["on"],
    });
    expect(calls).toContainEqual({
      method: "setToolFallbackMode",
      args: ["morphxml"],
    });
    expect(calls).toContainEqual({
      method: "setTranslationEnabled",
      args: [false],
    });
  });
});
