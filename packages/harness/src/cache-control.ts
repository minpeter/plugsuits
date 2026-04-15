import type { LanguageModel, ModelMessage, streamText } from "ai";

type ProviderOptions = NonNullable<
  Parameters<typeof streamText>[0]["providerOptions"]
>;

export const ANTHROPIC_EPHEMERAL_CACHE_CONTROL = {
  anthropic: {
    cacheControl: {
      type: "ephemeral",
    },
  },
} as const satisfies ProviderOptions;

const getStringField = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
};

export const isAnthropicModel = (model: LanguageModel): boolean => {
  const provider = getStringField(model, "provider");
  const modelId = getStringField(model, "modelId");

  return [provider, modelId].some((value) => {
    return (
      typeof value === "string" &&
      (value.includes("anthropic") || value.includes("claude"))
    );
  });
};

export const addEphemeralCacheControlToLastMessage = (params: {
  messages: ModelMessage[];
  model: LanguageModel;
  providerOptions?: ProviderOptions;
}): ModelMessage[] => {
  const providerOptions =
    params.providerOptions ?? ANTHROPIC_EPHEMERAL_CACHE_CONTROL;

  if (params.messages.length === 0 || !isAnthropicModel(params.model)) {
    return params.messages;
  }

  return params.messages.map((message, index) => {
    if (index !== params.messages.length - 1) {
      return message;
    }

    return {
      ...message,
      providerOptions: {
        ...(message.providerOptions ?? {}),
        ...providerOptions,
      },
    } satisfies ModelMessage;
  });
};
