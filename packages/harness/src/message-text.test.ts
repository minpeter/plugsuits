import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  getLastMessageText,
  getLastUserText,
  getMessageText,
} from "./message-text";

describe("message-text", () => {
  it("returns string content as-is by default", () => {
    const message: ModelMessage = { role: "user", content: "  hello  " };
    expect(getMessageText(message)).toBe("  hello  ");
  });

  it("optionally trims extracted text", () => {
    const message: ModelMessage = { role: "user", content: "  hello  " };
    expect(getMessageText(message, { trim: true })).toBe("hello");
  });

  it("joins text parts and ignores non-text parts", () => {
    const message: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "alpha" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "search",
          input: { q: "beta" },
        },
        { type: "text", text: "omega" },
      ],
    };

    expect(getMessageText(message)).toBe("alpha omega");
  });

  it("returns the last non-empty text for a given role", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: "reply" },
      {
        role: "user",
        content: [
          { type: "tool-call", toolName: "noop", toolCallId: "1", input: {} },
        ],
      },
      { role: "user", content: [{ type: "text", text: "last user" }] },
    ];

    expect(getLastMessageText(messages, "user")).toBe("last user");
  });

  it("provides a dedicated getLastUserText helper", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: "reply" },
      { role: "user", content: [{ type: "text", text: "  latest  " }] },
    ];

    expect(getLastUserText(messages, { trim: true })).toBe("latest");
  });
});
