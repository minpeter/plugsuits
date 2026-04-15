import type { LanguageModel } from "ai";
import type {
  AgentPrepareStepResult,
  AgentStreamDefaults,
  AgentStreamOptions,
} from "./types";

export interface AgentModelProfile {
  prepareStep?: (params: {
    messages: AgentStreamOptions["messages"];
    model: LanguageModel;
  }) => AgentPrepareStepResult | undefined;
  streamDefaults?: AgentStreamDefaults;
}

export const mergeAgentModelProfile = (params: {
  base?: AgentModelProfile;
  override?: AgentModelProfile;
}): AgentModelProfile | undefined => {
  const { base, override } = params;

  if (!(base || override)) {
    return undefined;
  }

  return {
    streamDefaults: {
      ...(base?.streamDefaults ?? {}),
      ...(override?.streamDefaults ?? {}),
      providerOptions:
        base?.streamDefaults?.providerOptions &&
        override?.streamDefaults?.providerOptions
          ? {
              ...base.streamDefaults.providerOptions,
              ...override.streamDefaults.providerOptions,
            }
          : (override?.streamDefaults?.providerOptions ??
            base?.streamDefaults?.providerOptions),
    },
    prepareStep: ({ messages, model }) => {
      const baseResult = base?.prepareStep?.({ messages, model });
      const overrideInput = baseResult?.messages ?? messages;
      const overrideResult = override?.prepareStep?.({
        messages: overrideInput,
        model,
      });

      if (!(baseResult || overrideResult)) {
        return undefined;
      }

      return {
        ...baseResult,
        ...overrideResult,
        messages: overrideResult?.messages ?? baseResult?.messages,
        providerOptions:
          baseResult?.providerOptions && overrideResult?.providerOptions
            ? {
                ...baseResult.providerOptions,
                ...overrideResult.providerOptions,
              }
            : (overrideResult?.providerOptions ?? baseResult?.providerOptions),
      };
    },
  };
};
