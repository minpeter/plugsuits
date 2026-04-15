import { describe, expect, it } from "vitest";
import { mergeAgentModelProfile } from "./model-profile";

describe("mergeAgentModelProfile", () => {
  it("merges stream defaults and prepareStep with override precedence", () => {
    const profile = mergeAgentModelProfile({
      base: {
        streamDefaults: {
          providerOptions: { openai: { parallelToolCalls: false } },
          seed: 1,
        },
        prepareStep: ({ messages }) => ({
          messages: [...messages, { role: "assistant", content: "base" }],
        }),
      },
      override: {
        streamDefaults: {
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
          temperature: 0,
        },
        prepareStep: ({ messages }) => ({
          messages: [...messages, { role: "assistant", content: "override" }],
        }),
      },
    });

    expect(profile?.streamDefaults).toEqual({
      providerOptions: {
        openai: { parallelToolCalls: false },
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
      seed: 1,
      temperature: 0,
    });
    expect(
      profile?.prepareStep?.({
        messages: [{ role: "user", content: "hello" }],
        model: {} as never,
      })
    ).toEqual({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "base" },
        { role: "assistant", content: "override" },
      ],
    });
  });
});
