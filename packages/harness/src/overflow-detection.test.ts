import { describe, expect, it } from "vitest";
import {
  isContextOverflowError,
  isUsageSilentOverflow,
} from "./overflow-detection";

describe("isContextOverflowError", () => {
  describe("Anthropic patterns", () => {
    it("detects 'prompt is too long'", () => {
      const error = new Error("prompt is too long");
      expect(isContextOverflowError(error)).toBe(true);
    });

    it("detects 'context_length_exceeded'", () => {
      const error = new Error("context_length_exceeded");
      expect(isContextOverflowError(error)).toBe(true);
    });

    it("detects 'too many tokens'", () => {
      const error = new Error("too many tokens in request");
      expect(isContextOverflowError(error)).toBe(true);
    });
  });

  describe("OpenAI / Friendli patterns", () => {
    it("detects 'maximum context length'", () => {
      const error = new Error(
        "This model's maximum context length is 128000 tokens"
      );
      expect(isContextOverflowError(error)).toBe(true);
    });

    it("detects 'context length exceeded'", () => {
      const error = new Error("Request context length exceeded maximum");
      expect(isContextOverflowError(error)).toBe(true);
    });

    it("detects 'token limit exceeded'", () => {
      const error = new Error("token limit exceeded");
      expect(isContextOverflowError(error)).toBe(true);
    });

    it("detects 'tokens exceeds the context window'", () => {
      const error = new Error("tokens exceeds the context window");
      expect(isContextOverflowError(error)).toBe(true);
    });
  });

  describe("Google / Gemini patterns", () => {
    it("detects 'exceeds the context window'", () => {
      const error = new Error("Request exceeds the context window limit");
      expect(isContextOverflowError(error)).toBe(true);
    });

    it("detects 'context window'", () => {
      const error = new Error("Prompt exceeds maximum context window size");
      expect(isContextOverflowError(error)).toBe(true);
    });

    it("detects 'input too long'", () => {
      const error = new Error("input too long");
      expect(isContextOverflowError(error)).toBe(true);
    });
  });

  describe("Generic / shared patterns", () => {
    it("detects 'input is too long'", () => {
      const error = new Error("input is too long");
      expect(isContextOverflowError(error)).toBe(true);
    });

    it("detects 'token limit'", () => {
      const error = new Error("token limit reached");
      expect(isContextOverflowError(error)).toBe(true);
    });
  });

  describe("Case insensitivity", () => {
    it("detects patterns with mixed case", () => {
      const error = new Error("PROMPT IS TOO LONG");
      expect(isContextOverflowError(error)).toBe(true);
    });

    it("detects patterns with partial case mismatch", () => {
      const error = new Error("Context_Length_Exceeded");
      expect(isContextOverflowError(error)).toBe(true);
    });
  });

  describe("False negatives (non-overflow errors)", () => {
    it("returns false for unrelated errors", () => {
      const error = new Error("Model not found");
      expect(isContextOverflowError(error)).toBe(false);
    });

    it("returns false for network errors", () => {
      const error = new Error("Connection timeout");
      expect(isContextOverflowError(error)).toBe(false);
    });

    it("returns false for authentication errors", () => {
      const error = new Error("Invalid API key");
      expect(isContextOverflowError(error)).toBe(false);
    });

    it("returns false for rate limit errors", () => {
      const error = new Error("Rate limit exceeded");
      expect(isContextOverflowError(error)).toBe(false);
    });

    it("returns false for generic parsing errors", () => {
      const error = new Error("Failed to parse response");
      expect(isContextOverflowError(error)).toBe(false);
    });
  });

  describe("Type safety", () => {
    it("returns false for non-Error objects", () => {
      expect(isContextOverflowError(null)).toBe(false);
      expect(isContextOverflowError(undefined)).toBe(false);
      expect(isContextOverflowError("prompt is too long")).toBe(false);
      expect(isContextOverflowError({ message: "prompt is too long" })).toBe(
        false
      );
    });

    it("returns false for objects without message", () => {
      const error = new Error("unknown error");
      expect(isContextOverflowError(error)).toBe(false);
    });
  });
});

describe("isUsageSilentOverflow", () => {
  describe("inputTokens field", () => {
    it("returns true when inputTokens exceed contextWindow", () => {
      const usage = { inputTokens: 100_000 };
      const contextWindow = 50_000;
      expect(isUsageSilentOverflow(usage, contextWindow)).toBe(true);
    });

    it("returns false when inputTokens are within contextWindow", () => {
      const usage = { inputTokens: 40_000 };
      const contextWindow = 50_000;
      expect(isUsageSilentOverflow(usage, contextWindow)).toBe(false);
    });

    it("returns false when inputTokens equal contextWindow", () => {
      const usage = { inputTokens: 50_000 };
      const contextWindow = 50_000;
      expect(isUsageSilentOverflow(usage, contextWindow)).toBe(false);
    });
  });

  describe("legacy promptTokens alias", () => {
    it("returns true when legacy promptTokens exceed contextWindow", () => {
      const usage = { promptTokens: 100_000 };
      const contextWindow = 50_000;
      expect(isUsageSilentOverflow(usage, contextWindow)).toBe(true);
    });

    it("returns false when legacy promptTokens are within contextWindow", () => {
      const usage = { promptTokens: 40_000 };
      const contextWindow = 50_000;
      expect(isUsageSilentOverflow(usage, contextWindow)).toBe(false);
    });

    it("returns false when legacy promptTokens equal contextWindow", () => {
      const usage = { promptTokens: 50_000 };
      const contextWindow = 50_000;
      expect(isUsageSilentOverflow(usage, contextWindow)).toBe(false);
    });
  });

  describe("field precedence", () => {
    it("prioritizes inputTokens over promptTokens", () => {
      const usage = { inputTokens: 100_000, promptTokens: 10_000 };
      const contextWindow = 50_000;
      expect(isUsageSilentOverflow(usage, contextWindow)).toBe(true);
    });

    it("falls back to promptTokens when inputTokens is undefined", () => {
      const usage = { inputTokens: undefined, promptTokens: 100_000 };
      const contextWindow = 50_000;
      expect(isUsageSilentOverflow(usage, contextWindow)).toBe(true);
    });

    it("uses default 0 when both fields are missing", () => {
      const usage = { inputTokens: undefined, promptTokens: undefined };
      const contextWindow: number = 50_000;
      expect(isUsageSilentOverflow(usage, contextWindow)).toBe(false);
    });

    it("uses default 0 when usage object is empty", () => {
      const usage = {};
      const contextWindow = 50_000;
      expect(isUsageSilentOverflow(usage as any, contextWindow)).toBe(false);
    });
  });

  describe("Edge cases", () => {
    it("handles zero contextWindow", () => {
      const usage = { inputTokens: 1 };
      const contextWindow = 0;
      expect(isUsageSilentOverflow(usage, contextWindow)).toBe(true);
    });

    it("handles large token counts (200k+)", () => {
      const usage = { inputTokens: 200_000 };
      const contextWindow = 128_000;
      expect(isUsageSilentOverflow(usage, contextWindow)).toBe(true);
    });

    it("handles very small token counts", () => {
      const usage = { inputTokens: 1 };
      const contextWindow: number = 2;
      expect(isUsageSilentOverflow(usage, contextWindow)).toBe(false);
    });
  });
});
