import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

const actualAi = await import("ai");

mock.module("ai", () => ({
  ...actualAi,
  generateText: mock(async () => {
    if (failTranslation) {
      throw new Error("forced translation failure");
    }

    return {
      text: "Converted text",
    };
  }),
  wrapLanguageModel: ({ model }: { model: unknown }) => model,
}));

mock.module("@friendliai/ai-provider", () => ({
  createFriendli: () => () => ({
    provider: "friendli",
    modelId: "mock-model",
  }),
}));

mock.module("@ai-sdk/anthropic", () => ({
  createAnthropic: () => () => ({
    provider: "anthropic",
    modelId: "mock-anthropic",
  }),
}));

let failTranslation = false;

const { agentManager } = await import("./agent");

describe("AgentManager translation preprocessing", () => {
  let originalTranslateEnabled = false;

  beforeEach(() => {
    originalTranslateEnabled = agentManager.isUserInputTranslationEnabled();
    agentManager.setUserInputTranslationEnabled(false);
    failTranslation = false;
  });

  afterEach(() => {
    agentManager.setUserInputTranslationEnabled(originalTranslateEnabled);
  });

  it("translates non-English input when enabled", async () => {
    agentManager.setUserInputTranslationEnabled(true);

    const result = await agentManager.preprocessUserInput("안녕하세요");

    expect(result.translated).toBe(true);
    expect(result.text).toBe("Converted text");
  });

  it("skips translation for ASCII input even when enabled", async () => {
    agentManager.setUserInputTranslationEnabled(true);

    const result = await agentManager.preprocessUserInput("hello");

    expect(result).toEqual({
      text: "hello",
      translated: false,
    });
  });

  it("falls back to original input when translation fails", async () => {
    failTranslation = true;
    agentManager.setUserInputTranslationEnabled(true);

    const input = "안녕하세요";
    const result = await agentManager.preprocessUserInput(input);

    expect(result).toEqual({
      text: input,
      translated: false,
    });
  });

  it("skips translation when disabled", async () => {
    const input = "안녕하세요";
    const result = await agentManager.preprocessUserInput(input);

    expect(result).toEqual({
      text: input,
      translated: false,
    });
  });
});
