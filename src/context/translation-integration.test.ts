import { beforeEach, describe, expect, it, mock } from "bun:test";
import { MessageHistory } from "./message-history";
import type {
  TranslationAgentManager,
  TranslationModelConfig,
} from "./translation";

const actualAi = await import("ai");

let shouldFailTranslation = false;
let generateTextCallCount = 0;

const mockedGenerateText = mock((options: Record<string, unknown>) => {
  generateTextCallCount += 1;

  if (shouldFailTranslation) {
    throw new Error("integration translation failure");
  }

  const prompt = typeof options.prompt === "string" ? options.prompt : "";

  if (prompt === "이 프로젝트의 구조를 설명해줘") {
    return { text: "Explain the structure of this project." };
  }

  if (prompt === "src/foo.ts 파일을 수정해줘") {
    return { text: "Please update src/foo.ts." };
  }

  if (prompt === "src/foo.ts 파일에서 `buildPath` 함수만 수정해줘") {
    return {
      text: "Please only update the `buildPath` function in src/foo.ts.",
    };
  }

  return { text: prompt };
});

mock.module("ai", () => ({
  ...actualAi,
  generateText: mockedGenerateText,
}));

const { translateToEnglish } = await import("./translation");

const createAgentManagerStub = (): TranslationAgentManager => {
  const modelConfig: TranslationModelConfig = {
    model: {} as TranslationModelConfig["model"],
    providerOptions: undefined,
    maxOutputTokens: 4000,
  };

  return {
    getTranslationModelConfig: () => modelConfig,
  };
};

const runPipeline = async (input: string, translationEnabled: boolean) => {
  const history = new MessageHistory();

  const translatedResult = translationEnabled
    ? await translateToEnglish(input, createAgentManagerStub())
    : {
        translated: false,
        text: input,
      };

  history.addUserMessage(translatedResult.text, translatedResult.originalText);

  return {
    history,
    translatedResult,
  };
};

describe("translation integration pipeline", () => {
  beforeEach(() => {
    shouldFailTranslation = false;
    generateTextCallCount = 0;
  });

  it("translates Korean input, stores originalContent, and keeps English for model", async () => {
    const { history, translatedResult } = await runPipeline(
      "이 프로젝트의 구조를 설명해줘",
      true
    );

    expect(translatedResult.translated).toBe(true);
    expect(translatedResult.text).toBe(
      "Explain the structure of this project."
    );
    expect(translatedResult.originalText).toBe("이 프로젝트의 구조를 설명해줘");

    const stored = history.getAll()[0];
    expect(stored?.originalContent).toBe("이 프로젝트의 구조를 설명해줘");
    expect(history.toModelMessages()).toEqual([
      {
        role: "user",
        content: "Explain the structure of this project.",
      },
    ]);
  });

  it("passes English input through unchanged without translation call", async () => {
    const { history, translatedResult } = await runPipeline(
      "Please list the files",
      true
    );

    expect(translatedResult).toEqual({
      translated: false,
      text: "Please list the files",
    });
    expect(generateTextCallCount).toBe(0);

    const stored = history.getAll()[0];
    expect(stored?.originalContent).toBeUndefined();
    expect(history.toModelMessages()).toEqual([
      {
        role: "user",
        content: "Please list the files",
      },
    ]);
  });

  it("keeps non-English input unchanged when translation is disabled", async () => {
    const { history, translatedResult } = await runPipeline(
      "src/foo.ts 파일을 수정해줘",
      false
    );

    expect(translatedResult).toEqual({
      translated: false,
      text: "src/foo.ts 파일을 수정해줘",
    });
    expect(generateTextCallCount).toBe(0);

    const stored = history.getAll()[0];
    expect(stored?.originalContent).toBeUndefined();
    expect(history.toModelMessages()).toEqual([
      {
        role: "user",
        content: "src/foo.ts 파일을 수정해줘",
      },
    ]);
  });

  it("falls back to original text when translation fails", async () => {
    shouldFailTranslation = true;

    const { history, translatedResult } = await runPipeline(
      "src/foo.ts 파일을 수정해줘",
      true
    );

    expect(translatedResult.translated).toBe(false);
    expect(translatedResult.text).toBe("src/foo.ts 파일을 수정해줘");
    expect(translatedResult.error).toContain("integration translation failure");

    const stored = history.getAll()[0];
    expect(stored?.originalContent).toBeUndefined();
    expect(history.toModelMessages()).toEqual([
      {
        role: "user",
        content: "src/foo.ts 파일을 수정해줘",
      },
    ]);
  });

  it("preserves code references during mixed-content translation", async () => {
    const { translatedResult } = await runPipeline(
      "src/foo.ts 파일에서 `buildPath` 함수만 수정해줘",
      true
    );

    expect(translatedResult.translated).toBe(true);
    expect(translatedResult.text).toContain("src/foo.ts");
    expect(translatedResult.text).toContain("`buildPath`");
  });
});
