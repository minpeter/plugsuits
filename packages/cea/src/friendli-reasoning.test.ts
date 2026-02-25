import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import {
  applyFriendliInterleavedField,
  buildFriendliChatTemplateKwargs,
  getFriendliSelectableReasoningModes,
  resolveFriendliReasoningMode,
} from "./friendli-reasoning";

describe("friendli reasoning config", () => {
  it("builds chat_template_kwargs with configurable boolean polarity", () => {
    expect(buildFriendliChatTemplateKwargs("zai-org/GLM-5", "off")).toEqual({
      enable_thinking: false,
      clear_thinking: true,
    });

    expect(buildFriendliChatTemplateKwargs("zai-org/GLM-5", "on")).toEqual({
      enable_thinking: true,
      clear_thinking: true,
    });

    expect(
      buildFriendliChatTemplateKwargs("zai-org/GLM-5", "preserved")
    ).toEqual({
      enable_thinking: true,
      clear_thinking: false,
    });
  });

  it("falls back to supported modes when requested mode is unavailable", () => {
    expect(resolveFriendliReasoningMode("unknown-model", "preserved")).toBe(
      "preserved"
    );
    expect(
      resolveFriendliReasoningMode("MiniMaxAI/MiniMax-M2.5", "interleaved")
    ).toBe("interleaved");
    expect(resolveFriendliReasoningMode("MiniMaxAI/MiniMax-M2.5", "off")).toBe(
      "on"
    );
    expect(
      resolveFriendliReasoningMode("MiniMaxAI/MiniMax-M2.5", "preserved")
    ).toBe("interleaved");
  });

  it("injects interleaved reasoning field for assistant messages", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "internal thinking" },
          { type: "text", text: "final answer" },
        ],
      } as ModelMessage,
      {
        role: "user",
        content: "next prompt",
      },
    ];

    const mapped = applyFriendliInterleavedField(
      messages,
      "zai-org/GLM-5",
      "interleaved"
    );

    expect((mapped[0] as Record<string, unknown>).reasoning_content).toBe(
      "internal thinking"
    );
    expect((mapped[1] as Record<string, unknown>).reasoning_content).toBe(
      undefined
    );
  });

  it("enforces MiniMax M2.5 semantics", () => {
    expect(
      getFriendliSelectableReasoningModes("MiniMaxAI/MiniMax-M2.5")
    ).toEqual(["on", "interleaved"]);

    expect(
      buildFriendliChatTemplateKwargs("MiniMaxAI/MiniMax-M2.5", "on")
    ).toBe(undefined);
    expect(
      buildFriendliChatTemplateKwargs("MiniMaxAI/MiniMax-M2.5", "interleaved")
    ).toBe(undefined);

    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "chain" },
          { type: "text", text: "answer" },
        ],
        reasoning_content: "stale reasoning",
      } as ModelMessage,
    ];

    const onMapped = applyFriendliInterleavedField(
      messages,
      "MiniMaxAI/MiniMax-M2.5",
      "on"
    );
    expect((onMapped[0] as Record<string, unknown>).reasoning_content).toBe(
      undefined
    );
    expect(Array.isArray(onMapped[0]?.content)).toBe(true);
    expect((onMapped[0]?.content as Array<{ type: string }>)[0]?.type).toBe(
      "text"
    );

    const offMapped = applyFriendliInterleavedField(
      messages,
      "MiniMaxAI/MiniMax-M2.5",
      "off"
    );
    expect((offMapped[0] as Record<string, unknown>).reasoning_content).toBe(
      undefined
    );

    const interleavedMapped = applyFriendliInterleavedField(
      messages,
      "MiniMaxAI/MiniMax-M2.5",
      "interleaved"
    );
    expect(
      (interleavedMapped[0] as Record<string, unknown>).reasoning_content
    ).toBe("chain");
  });

  it("strips reasoning parts in non-interleaved modes", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "only-think" }],
      } as ModelMessage,
    ];

    const mapped = applyFriendliInterleavedField(
      messages,
      "zai-org/GLM-5",
      "on"
    );
    expect(mapped[0]?.content).toBe("");
    expect((mapped[0] as Record<string, unknown>).reasoning_content).toBe(
      undefined
    );
  });
});
