import type { Command, CommandResult } from "@ai-sdk-tool/harness";
import type { ModelMessage } from "ai";

export const NEXT_USER_PROMPT_SENTINEL =
  "THE NEXT USER PROMPT IS LOCATED HERE.";

export const appendNextUserPromptSentinel = (
  messages: ModelMessage[]
): ModelMessage[] => {
  return [
    ...messages,
    {
      role: "user",
      content: NEXT_USER_PROMPT_SENTINEL,
    },
  ];
};

export const createRenderCommand = (
  _getData: () => unknown | Promise<unknown>
): Command => ({
  name: "render",
  description: "Render conversation as raw prompt text",
  execute: (): CommandResult => {
    return {
      success: false,
      message:
        "Render is unavailable because the provider-specific render API was removed.",
    };
  },
});
