import { MessageHistory } from "@ai-sdk-tool/harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TranslationAgentManager,
  TranslationModelConfig,
} from "./translation";

const translationState = vi.hoisted(() => ({
  generateTextCallCount: 0,
  shouldFailTranslation: false,
}));
const USER_TEXT_CDATA_REGEX =
  /<user_text><!\[CDATA\[([\s\S]*)\]\]><\/user_text>/;
const CDATA_SPLIT_SEQUENCE = "]]]]><![CDATA[>";
const CDATA_END_SEQUENCE = "]]>";

const extractUserTextFromPrompt = (prompt: string): string => {
  const match = prompt.match(USER_TEXT_CDATA_REGEX);
  if (!match) {
    return prompt;
  }

  return match[1].split(CDATA_SPLIT_SEQUENCE).join(CDATA_END_SEQUENCE);
};

const mockedGenerateText = vi.fn((options: Record<string, unknown>) => {
  translationState.generateTextCallCount += 1;

  if (translationState.shouldFailTranslation) {
    throw new Error("integration translation failure");
  }

  const prompt = typeof options.prompt === "string" ? options.prompt : "";
  const userText = extractUserTextFromPrompt(prompt);

  if (userText === "이 프로젝트의 구조를 설명해줘") {
    return Promise.resolve({
      text: "Explain the structure of this project.",
    } as never);
  }

  if (userText === "workspace/foo.ts 파일을 수정해줘") {
    return Promise.resolve({
      text: "Please update workspace/foo.ts.",
    } as never);
  }

  if (userText === "workspace/foo.ts 파일에서 `buildPath` 함수만 수정해줘") {
    return Promise.resolve({
      text: "Please only update the `buildPath` function in workspace/foo.ts.",
    } as never);
  }

  return Promise.resolve({ text: userText } as never);
});

const {
  resetGenerateTextForTesting,
  setGenerateTextForTesting,
  translateToEnglish,
} = await import("./translation");

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
    translationState.shouldFailTranslation = false;
    translationState.generateTextCallCount = 0;
    mockedGenerateText.mockClear();
    setGenerateTextForTesting(mockedGenerateText as never);
  });

  afterEach(() => {
    resetGenerateTextForTesting();
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
    expect(translationState.generateTextCallCount).toBe(0);

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
      "workspace/foo.ts 파일을 수정해줘",
      false
    );

    expect(translatedResult).toEqual({
      translated: false,
      text: "workspace/foo.ts 파일을 수정해줘",
    });
    expect(translationState.generateTextCallCount).toBe(0);

    const stored = history.getAll()[0];
    expect(stored?.originalContent).toBeUndefined();
    expect(history.toModelMessages()).toEqual([
      {
        role: "user",
        content: "workspace/foo.ts 파일을 수정해줘",
      },
    ]);
  });

  it("falls back to original text when translation fails", async () => {
    translationState.shouldFailTranslation = true;

    const { history, translatedResult } = await runPipeline(
      "workspace/foo.ts 파일을 수정해줘",
      true
    );

    expect(translatedResult.translated).toBe(false);
    expect(translatedResult.text).toBe("workspace/foo.ts 파일을 수정해줘");
    expect(translatedResult.error).toContain("integration translation failure");

    const stored = history.getAll()[0];
    expect(stored?.originalContent).toBeUndefined();
    expect(history.toModelMessages()).toEqual([
      {
        role: "user",
        content: "workspace/foo.ts 파일을 수정해줘",
      },
    ]);
  });

  it("preserves code references during mixed-content translation", async () => {
    const { translatedResult } = await runPipeline(
      "workspace/foo.ts 파일에서 `buildPath` 함수만 수정해줘",
      true
    );

    expect(translatedResult.translated).toBe(true);
    expect(translatedResult.text).toContain("workspace/foo.ts");
    expect(translatedResult.text).toContain("`buildPath`");
  });
});
