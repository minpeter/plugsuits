import type { ModelMessage } from "ai";
import {
  type FriendliReasoningModelConfig,
  getFriendliModelById,
} from "./friendli-models";
import { DEFAULT_REASONING_MODE, type ReasoningMode } from "./reasoning-mode";

export type FriendliReasoningConfig = FriendliReasoningModelConfig;

const DEFAULT_FRIENDLI_REASONING_CONFIG: FriendliReasoningConfig = {
  reasoning_toggle: "enable_thinking",
  preserved_toggle: "clear_thinking",
  interleaved_field: "reasoning_content",
  on_value: {
    reasoning_toggle: true,
    preserved_toggle: false,
  },
};

const resolveFriendliReasoningCapability = (modelId: string) => {
  const model = getFriendliModelById(modelId);
  const hasReasoningSupport = model ? model.reasoning !== null : true;
  const config = model?.reasoning ?? DEFAULT_FRIENDLI_REASONING_CONFIG;
  const alwaysReasoning =
    hasReasoningSupport && config.reasoning_toggle === null;

  return {
    config,
    hasReasoningSupport,
    alwaysReasoning,
  };
};

export const getFriendliReasoningConfig = (
  modelId: string
): FriendliReasoningConfig => {
  const { config } = resolveFriendliReasoningCapability(modelId);

  return {
    ...config,
    on_value: {
      ...config.on_value,
    },
  };
};

export const resolveFriendliReasoningMode = (
  modelId: string,
  requestedMode: ReasoningMode
): ReasoningMode => {
  const { config, hasReasoningSupport, alwaysReasoning } =
    resolveFriendliReasoningCapability(modelId);
  const supportsOn = hasReasoningSupport;
  const supportsInterleaved =
    hasReasoningSupport && config.interleaved_field !== null;
  const supportsPreserved =
    supportsInterleaved && config.preserved_toggle !== null;

  if (requestedMode === "off") {
    return alwaysReasoning ? "on" : "off";
  }

  if (requestedMode === "on") {
    return supportsOn ? "on" : DEFAULT_REASONING_MODE;
  }

  if (requestedMode === "interleaved") {
    if (supportsInterleaved) {
      return "interleaved";
    }
    return supportsOn ? "on" : DEFAULT_REASONING_MODE;
  }

  if (supportsPreserved) {
    return "preserved";
  }

  if (supportsInterleaved) {
    return "interleaved";
  }

  return supportsOn ? "on" : DEFAULT_REASONING_MODE;
};

export const getFriendliSelectableReasoningModes = (
  modelId: string
): ReasoningMode[] => {
  const { config, hasReasoningSupport, alwaysReasoning } =
    resolveFriendliReasoningCapability(modelId);
  const selectable: ReasoningMode[] = [];

  if (!alwaysReasoning) {
    selectable.push("off");
  }

  if (hasReasoningSupport) {
    selectable.push("on");
  }

  if (hasReasoningSupport && config.interleaved_field !== null) {
    selectable.push("interleaved");
  }

  if (
    config.interleaved_field !== null &&
    config.preserved_toggle !== null &&
    !alwaysReasoning
  ) {
    selectable.push("preserved");
  }

  if (selectable.length === 0) {
    return [DEFAULT_REASONING_MODE];
  }

  return selectable;
};

const setToggleValue = (
  toggleValues: Record<string, boolean>,
  key: string | null,
  onValue: boolean,
  enabled: boolean
): void => {
  if (!key) {
    return;
  }

  toggleValues[key] = enabled ? onValue : !onValue;
};

export const buildFriendliChatTemplateKwargs = (
  modelId: string,
  requestedMode: ReasoningMode
): Record<string, boolean> | undefined => {
  const config = getFriendliReasoningConfig(modelId);
  const mode = resolveFriendliReasoningMode(modelId, requestedMode);
  const toggles: Record<string, boolean> = {};

  setToggleValue(
    toggles,
    config.reasoning_toggle,
    config.on_value.reasoning_toggle,
    mode !== "off"
  );
  setToggleValue(
    toggles,
    config.preserved_toggle,
    config.on_value.preserved_toggle,
    mode === "preserved"
  );

  if (Object.keys(toggles).length === 0) {
    return undefined;
  }

  return toggles;
};

const extractReasoningTextFromPart = (part: unknown): string | null => {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    return null;
  }

  const type = (part as { type: unknown }).type;
  if (type !== "reasoning") {
    return null;
  }

  if ("text" in part && typeof (part as { text: unknown }).text === "string") {
    return (part as { text: string }).text;
  }

  if (
    "reasoning" in part &&
    typeof (part as { reasoning: unknown }).reasoning === "string"
  ) {
    return (part as { reasoning: string }).reasoning;
  }

  return null;
};

const getReasoningTextFromAssistantMessage = (
  message: ModelMessage
): string | null => {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return null;
  }

  const chunks: string[] = [];

  for (const part of message.content) {
    const reasoningText = extractReasoningTextFromPart(part);
    if (reasoningText) {
      chunks.push(reasoningText);
    }
  }

  if (chunks.length === 0) {
    return null;
  }

  return chunks.join("");
};

const removeReasoningPartsFromAssistantMessage = (
  message: ModelMessage
): ModelMessage => {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }

  const filteredContent = message.content.filter((part) => {
    return !(
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      (part as { type: unknown }).type === "reasoning"
    );
  });

  if (filteredContent.length === message.content.length) {
    return message;
  }

  if (filteredContent.length === 0) {
    return {
      ...message,
      content: "",
    };
  }

  return {
    ...message,
    content: filteredContent,
  };
};

export const applyFriendliInterleavedField = (
  messages: ModelMessage[],
  modelId: string,
  requestedMode: ReasoningMode
): ModelMessage[] => {
  const config = getFriendliReasoningConfig(modelId);
  const mode = resolveFriendliReasoningMode(modelId, requestedMode);

  const interleavedField = config.interleaved_field;
  if (!interleavedField) {
    return messages;
  }

  return messages.map((message) => {
    if (mode !== "interleaved" && mode !== "preserved") {
      const cleanedMessage = removeReasoningPartsFromAssistantMessage(message);

      if (
        typeof cleanedMessage === "object" &&
        cleanedMessage !== null &&
        interleavedField in cleanedMessage
      ) {
        const { [interleavedField]: _omitted, ...rest } =
          cleanedMessage as Record<string, unknown>;
        return rest as ModelMessage;
      }

      return cleanedMessage;
    }

    const reasoningText = getReasoningTextFromAssistantMessage(message);
    if (!reasoningText) {
      return message;
    }

    return {
      ...message,
      [interleavedField]: reasoningText,
    };
  });
};
