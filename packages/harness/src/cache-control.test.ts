import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_EPHEMERAL_CACHE_CONTROL,
  addEphemeralCacheControlToLastMessage,
  isAnthropicModel,
} from "./cache-control";

describe("cache-control", () => {
  it("detects anthropic models from provider or model id", () => {
    expect(
      isAnthropicModel({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      } as never)
    ).toBe(true);
    expect(
      isAnthropicModel({ provider: "openai", modelId: "gpt-4.1" } as never)
    ).toBe(false);
  });

  it("adds ephemeral cache control to only the last message for anthropic models", () => {
    const messages = addEphemeralCacheControlToLastMessage({
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "question" },
      ],
      model: { provider: "anthropic", modelId: "claude-sonnet-4-6" } as never,
    });

    expect(messages[0]).not.toHaveProperty("providerOptions");
    expect(messages[1]).toMatchObject({
      providerOptions: ANTHROPIC_EPHEMERAL_CACHE_CONTROL,
    });
  });

  it("keeps non-anthropic messages unchanged", () => {
    const original = [{ role: "user", content: "question" }];
    const messages = addEphemeralCacheControlToLastMessage({
      messages: original,
      model: { provider: "openai", modelId: "gpt-4.1" } as never,
    });

    expect(messages).toEqual(original);
  });
});
