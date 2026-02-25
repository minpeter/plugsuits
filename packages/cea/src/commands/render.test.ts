import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import {
  appendNextUserPromptSentinel,
  NEXT_USER_PROMPT_SENTINEL,
} from "./render";

describe("render prompt shaping", () => {
  it("appends the sentinel as the last user message", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "existing prompt",
      },
      {
        role: "assistant",
        content: "existing response",
      },
    ];

    const withSentinel = appendNextUserPromptSentinel(messages);

    expect(withSentinel).toHaveLength(3);
    expect(withSentinel.at(-1)).toEqual({
      role: "user",
      content: NEXT_USER_PROMPT_SENTINEL,
    });
    expect(NEXT_USER_PROMPT_SENTINEL).toBe(
      NEXT_USER_PROMPT_SENTINEL.toUpperCase()
    );
  });

  it("does not mutate the original message array", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: "final answer",
      },
    ];

    const withSentinel = appendNextUserPromptSentinel(messages);

    expect(messages).toHaveLength(1);
    expect(withSentinel).not.toBe(messages);
    expect(withSentinel).toHaveLength(2);
  });
});
