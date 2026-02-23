import { generateText } from "ai";

const TRANSLATION_TIMEOUT_MS = 30_000;

export const TRANSLATION_SYSTEM_PROMPT =
  "Translate the user text into clear English. Preserve all code snippets, file paths, variable names, function names, commands, API/library names, and technical terms exactly as written. Return only the translated text with no markdown, quotes, or extra explanation. If the input is already English, return it unchanged.";

export interface TranslationResult {
  error?: string;
  originalText?: string;
  text: string;
  translated: boolean;
}

type GenerateTextOptions = Parameters<typeof generateText>[0];

export interface TranslationModelConfig {
  maxOutputTokens: number;
  model: GenerateTextOptions["model"];
  providerOptions: GenerateTextOptions["providerOptions"];
}

export interface TranslationAgentManager {
  getTranslationModelConfig(): TranslationModelConfig;
}

const hasNonAsciiCharacter = (text: string): boolean => {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code !== undefined && code > 0x7f) {
      return true;
    }
  }

  return false;
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

export const isNonEnglish = (text: string): boolean => {
  if (text.trim().length === 0) {
    return false;
  }

  return hasNonAsciiCharacter(text);
};

export const translateToEnglish = async (
  text: string,
  agentManager: TranslationAgentManager
): Promise<TranslationResult> => {
  if (!isNonEnglish(text)) {
    return {
      translated: false,
      text,
    };
  }

  try {
    const { model, providerOptions, maxOutputTokens } =
      agentManager.getTranslationModelConfig();

    const result = await generateText({
      model,
      system: TRANSLATION_SYSTEM_PROMPT,
      prompt: text,
      maxOutputTokens,
      providerOptions,
      abortSignal: AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
    });

    const translatedText = result.text.trim();
    if (translatedText.length === 0 || translatedText === text) {
      return {
        translated: false,
        text,
      };
    }

    return {
      translated: true,
      text: translatedText,
      originalText: text,
    };
  } catch (error) {
    return {
      translated: false,
      text,
      error: toErrorMessage(error),
    };
  }
};
