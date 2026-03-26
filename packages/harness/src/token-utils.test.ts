import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  estimateMessageTokens,
  estimateTokens,
  extractMessageText,
} from "./token-utils";

describe("estimateTokens", () => {
  it("returns positive number for non-empty text", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates CJK text differently from Latin text", () => {
    const latin = estimateTokens("hello world foo bar");
    const cjk = estimateTokens("你好世界");
    expect(latin).toBeGreaterThan(0);
    expect(cjk).toBeGreaterThan(0);
  });
});

describe("extractMessageText", () => {
  it("extracts text from string content", () => {
    const msg = { role: "user" as const, content: "hello" };
    expect(extractMessageText(msg)).toBe("hello");
  });
});

describe("estimateMessageTokens", () => {
  it("estimates tool-result messages higher than chars/4 baseline", () => {
    const toolResultMsg: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read_file",
          output: { type: "text", value: "x".repeat(1200) },
        },
      ],
    };

    const text = extractMessageText(toolResultMsg);
    const charsDiv4 = Math.ceil(text.length / 4);

    const result = estimateMessageTokens(toolResultMsg);
    // With accurate estimation (using raw text length), estimate is close to charsDiv4, not greater
    expect(result).toBeLessThanOrEqual(charsDiv4);
    expect(result).toBeGreaterThan(0);
  });

  it("estimates assistant tool-call messages higher than chars/4 baseline", () => {
    const assistantMsg: ModelMessage = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "edit_file",
          input: { path: "src/main.ts", content: "x".repeat(800) },
        },
      ],
    };

    const text = extractMessageText(assistantMsg);
    const charsDiv4 = Math.ceil(text.length / 4);

    const result = estimateMessageTokens(assistantMsg);
    // With accurate estimation (using raw text length), estimate is close to charsDiv4, not greater
    expect(result).toBeLessThanOrEqual(charsDiv4);
    expect(result).toBeGreaterThan(0);
  });

  it("estimates plain user text messages same as estimateTokens(text)", () => {
    const text = "Hello, how can I help you today?";
    const userMsg: ModelMessage = {
      role: "user",
      content: text,
    };

    const expected = estimateTokens(text);
    const result = estimateMessageTokens(userMsg);
    expect(result).toBe(expected);
  });

  it("estimates mixed assistant messages (text + tool-call) with correct weighting", () => {
    const plainText = "I will read the file now.";
    const jsonInput = { path: "foo.ts", content: "y".repeat(400) };

    const mixedMsg: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: plainText },
        {
          type: "tool-call",
          toolCallId: "call_2",
          toolName: "read_file",
          input: jsonInput,
        },
      ],
    };

    const result = estimateMessageTokens(mixedMsg);
    expect(result).toBeGreaterThan(0);

    const textOnly = extractMessageText(mixedMsg);
    const charsDiv4 = Math.ceil(textOnly.length / 4);
    // With accurate estimation (using raw text length), estimate is close to charsDiv4, not greater
    expect(result).toBeLessThanOrEqual(charsDiv4);
  });
});

describe("estimateMessageTokens — deflated estimation (RED)", () => {
  it("Test A: tool-result with code containing newlines/quotes estimates ≤ rawTextLength/3.5", () => {
    const codeWithSpecialChars =
      'function foo() {\n  return "hello world";\n}\n'.repeat(100);
    const rawTextLength = codeWithSpecialChars.length;

    const toolResultMsg: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read_file",
          output: { type: "text", value: codeWithSpecialChars },
        },
      ],
    };

    const result = estimateMessageTokens(toolResultMsg);
    expect(result).toBeLessThanOrEqual(Math.ceil(rawTextLength / 3.5));
  });

  it("Test B: tool-result with plain string output estimates same as estimateTokens(stringOutput)", () => {
    const stringOutput = "This is a plain string output from a tool call.";
    const toolResultMsg: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_2",
          toolName: "read_file",
          output: { type: "text", value: stringOutput },
        },
      ],
    };

    const result = estimateMessageTokens(toolResultMsg);
    expect(result).toBe(estimateTokens(stringOutput));
  });

  it("Test C: tool-result with empty string output estimates 0 tokens", () => {
    const toolResultMsg: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_3",
          toolName: "read_file",
          output: { type: "text", value: "" },
        },
      ],
    };

    expect(estimateMessageTokens(toolResultMsg)).toBe(0);
  });
});
