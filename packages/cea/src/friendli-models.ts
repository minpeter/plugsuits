export interface FriendliReasoningToggleOnValueConfig {
  preserved_toggle: boolean;
  reasoning_toggle: boolean;
}

export interface FriendliReasoningModelConfig {
  interleaved_field: string | null;
  on_value: FriendliReasoningToggleOnValueConfig;
  preserved_toggle: string | null;
  reasoning_toggle: string | null;
}

export interface FriendliModelInfo {
  id: string;
  name?: string;
  provider: "friendli";
  reasoning: FriendliReasoningModelConfig | null;
  type?: "serverless" | "dedicated";
}

const DEFAULT_FRIENDLI_REASONING: FriendliReasoningModelConfig = {
  reasoning_toggle: "enable_thinking",
  preserved_toggle: "clear_thinking",
  interleaved_field: "reasoning_content",
  on_value: {
    reasoning_toggle: true,
    preserved_toggle: false,
  },
};

export const FRIENDLI_MODELS: readonly FriendliModelInfo[] = [
  {
    id: "MiniMaxAI/MiniMax-M2.5",
    name: "MiniMax M2.5",
    provider: "friendli",
    type: "serverless",
    reasoning: {
      ...DEFAULT_FRIENDLI_REASONING,
      reasoning_toggle: null,
      preserved_toggle: null,
    },
  },
  {
    id: "MiniMaxAI/MiniMax-M2.1",
    name: "MiniMax M2.1",
    provider: "friendli",
    type: "serverless",
    reasoning: {
      ...DEFAULT_FRIENDLI_REASONING,
      reasoning_toggle: null,
    },
  },
  {
    id: "zai-org/GLM-5",
    name: "GLM 5",
    provider: "friendli",
    type: "serverless",
    reasoning: {
      ...DEFAULT_FRIENDLI_REASONING,
    },
  },
  {
    id: "zai-org/GLM-4.7",
    name: "GLM 4.7",
    provider: "friendli",
    type: "serverless",
    reasoning: {
      ...DEFAULT_FRIENDLI_REASONING,
    },
  },
] as const;

export const getFriendliModelById = (
  modelId: string
): FriendliModelInfo | undefined => {
  return FRIENDLI_MODELS.find((model) => model.id === modelId);
};
