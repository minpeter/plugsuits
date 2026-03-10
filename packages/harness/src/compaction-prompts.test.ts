import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  createModelSummarizer,
  DEFAULT_SUMMARIZATION_PROMPT,
  ITERATIVE_SUMMARIZATION_PROMPT,
} from "./compaction-prompts";

// ─── Helpers ───

function makeMessages(
  ...specs: Array<{ role: string; content: string | object[] }>
): ModelMessage[] {
  return specs.map((s) => s as ModelMessage);
}

/**
 * Create a MockLanguageModelV3 that returns a fixed text response.
 */
function createMockModel(responseText: string) {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: "text" as const, text: responseText }],
      finishReason: "stop" as const,
      usage: { inputTokens: 100, outputTokens: 50 },
    },
  });
}

// ─── Tests ───

describe("compaction-prompts", () => {
  describe("DEFAULT_SUMMARIZATION_PROMPT", () => {
    it("contains required section headers", () => {
      expect(DEFAULT_SUMMARIZATION_PROMPT).toContain("## Summary");
      expect(DEFAULT_SUMMARIZATION_PROMPT).toContain("## Context");
      expect(DEFAULT_SUMMARIZATION_PROMPT).toContain("## Current State");
    });

    it("is a non-empty string", () => {
      expect(typeof DEFAULT_SUMMARIZATION_PROMPT).toBe("string");
      expect(DEFAULT_SUMMARIZATION_PROMPT.length).toBeGreaterThan(100);
    });
  });

  describe("createModelSummarizer", () => {
    it("returns a function", () => {
      const mockModel = createMockModel("test summary");
      const summarizer = createModelSummarizer(mockModel);
      expect(typeof summarizer).toBe("function");
    });

    it("returns structured fallback for empty messages", async () => {
      const mockModel = createMockModel("should not be called");
      const summarizer = createModelSummarizer(mockModel);

      const result = await summarizer([]);

      expect(result).toContain("## Summary");
      expect(result).toContain("No conversation history");
      // Model should NOT be called for empty messages
      expect(mockModel.doGenerateCalls).toHaveLength(0);
    });

    it("calls the model with formatted messages", async () => {
      const expectedSummary =
        "## Summary\nUser asked about weather.\n\n## Context\n- Location: Seoul\n\n## Current State\n- Awaiting response";
      const mockModel = createMockModel(expectedSummary);
      const summarizer = createModelSummarizer(mockModel);

      const messages = makeMessages(
        { role: "user", content: "What's the weather in Seoul?" },
        {
          role: "assistant",
          content: "The weather in Seoul is sunny with 25°C.",
        }
      );

      const result = await summarizer(messages);

      expect(result).toBe(expectedSummary);
      expect(mockModel.doGenerateCalls).toHaveLength(1);
    });

    it("handles model returning empty text with fallback", async () => {
      const mockModel = createMockModel("");
      const summarizer = createModelSummarizer(mockModel);

      const messages = makeMessages({
        role: "user",
        content: "Hello",
      });

      const result = await summarizer(messages);

      expect(result).toContain("## Summary");
      expect(result).toContain("summary generation failed");
    });

    it("accepts custom prompt option", async () => {
      const customPrompt = "Summarize in haiku format.";
      const mockModel = createMockModel(
        "Context flows here\nMessages compressed to form\nWisdom preserved well"
      );
      const summarizer = createModelSummarizer(mockModel, {
        prompt: customPrompt,
      });

      const messages = makeMessages({
        role: "user",
        content: "Tell me a story.",
      });

      await summarizer(messages);

      // Verify the model was called
      expect(mockModel.doGenerateCalls).toHaveLength(1);

      // The system prompt should contain our custom prompt
      const callPrompt = mockModel.doGenerateCalls[0].prompt;
      const systemMessages = callPrompt.filter((m: any) => m.role === "system");
      expect(systemMessages.length).toBeGreaterThan(0);
      const systemContent = systemMessages
        .map((m: any) => {
          if (typeof m.content === "string") {
            return m.content;
          }
          if (Array.isArray(m.content)) {
            return m.content.map((p: any) => p.text ?? "").join("");
          }
          return "";
        })
        .join("");
      expect(systemContent).toContain(customPrompt);
    });

    it("accepts custom maxOutputTokens option", async () => {
      const mockModel = createMockModel("short summary");
      const summarizer = createModelSummarizer(mockModel, {
        maxOutputTokens: 256,
      });

      const messages = makeMessages({
        role: "user",
        content: "Hello",
      });

      await summarizer(messages);

      expect(mockModel.doGenerateCalls).toHaveLength(1);
      expect(mockModel.doGenerateCalls[0].maxOutputTokens).toBe(256);
    });

    it("formats tool-call messages in the input", async () => {
      const mockModel = createMockModel("## Summary\nTool was used.");
      const summarizer = createModelSummarizer(mockModel);

      const messages = makeMessages(
        { role: "user", content: "Read the file" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "read_file",
              input: { path: "/test.ts" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "read_file",
              output: { type: "text", value: "file contents here" },
            },
          ],
        },
        { role: "assistant", content: "Here are the file contents." }
      );

      const result = await summarizer(messages);
      expect(result).toBe("## Summary\nTool was used.");
      expect(mockModel.doGenerateCalls).toHaveLength(1);

      // Check that the formatted input includes tool info
      const callPrompt = mockModel.doGenerateCalls[0].prompt;
      const userMessages = callPrompt.filter((m: any) => m.role === "user");
      expect(userMessages.length).toBeGreaterThan(0);
      const userContent = userMessages
        .map((m: any) => {
          if (typeof m.content === "string") {
            return m.content;
          }
          if (Array.isArray(m.content)) {
            return m.content.map((p: any) => p.text ?? "").join("");
          }
          return "";
        })
        .join("");
      expect(userContent).toContain("read_file");
      expect(userContent).toContain("tool-call");
      expect(userContent).toContain("tool-result");
    });

    it("truncates long tool inputs and outputs", async () => {
      const mockModel = createMockModel("## Summary\nSummarized.");
      const summarizer = createModelSummarizer(mockModel);

      const longInput = "x".repeat(500);
      const longOutput = "y".repeat(500);

      const messages = makeMessages(
        { role: "user", content: "Do something" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "execute",
              input: { data: longInput },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "execute",
              output: longOutput,
            },
          ],
        }
      );

      await summarizer(messages);

      expect(mockModel.doGenerateCalls).toHaveLength(1);
      const callPrompt = mockModel.doGenerateCalls[0].prompt;
      const userMessages = callPrompt.filter((m: any) => m.role === "user");
      const userContent = userMessages
        .map((m: any) => {
          if (typeof m.content === "string") {
            return m.content;
          }
          if (Array.isArray(m.content)) {
            return m.content.map((p: any) => p.text ?? "").join("");
          }
          return "";
        })
        .join("");

      // Should contain truncation indicators
      expect(userContent).toContain("...");
      // Should not contain the full 500-char strings
      expect(userContent.length).toBeLessThan(
        longInput.length + longOutput.length + 500
      );
    });

    it("works as a CompactionConfig.summarizeFn", async () => {
      // Verifies the function signature is compatible
      const mockModel = createMockModel(
        "## Summary\nConversation about testing."
      );
      const summarizeFn = createModelSummarizer(mockModel);

      // Same signature as CompactionConfig.summarizeFn
      const fn: (messages: ModelMessage[]) => Promise<string> = summarizeFn;

      const result = await fn([
        { role: "user", content: "test" } as ModelMessage,
      ]);

      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("ITERATIVE_SUMMARIZATION_PROMPT", () => {
    it("contains required section headers", () => {
      expect(ITERATIVE_SUMMARIZATION_PROMPT).toContain("## Summary");
      expect(ITERATIVE_SUMMARIZATION_PROMPT).toContain("## Context");
      expect(ITERATIVE_SUMMARIZATION_PROMPT).toContain("## Current State");
    });

    it("contains iterative update instructions", () => {
      expect(ITERATIVE_SUMMARIZATION_PROMPT).toContain("iterative update");
      expect(ITERATIVE_SUMMARIZATION_PROMPT).toContain("previous summary");
      expect(ITERATIVE_SUMMARIZATION_PROMPT).toContain("MERGE");
    });

    it("is a non-empty string", () => {
      expect(typeof ITERATIVE_SUMMARIZATION_PROMPT).toBe("string");
      expect(ITERATIVE_SUMMARIZATION_PROMPT.length).toBeGreaterThan(100);
    });
  });

  describe("createModelSummarizer with previousSummary", () => {
    it("uses iterative prompt when previousSummary is provided", async () => {
      const expectedSummary =
        "## Summary\nUpdated summary with merged context.";
      const mockModel = createMockModel(expectedSummary);
      const summarizer = createModelSummarizer(mockModel);

      const messages = makeMessages(
        { role: "user", content: "New message after compaction" },
        { role: "assistant", content: "Response to new message" }
      );

      const previousSummary = "## Summary\nOld conversation about weather.";
      const result = await summarizer(messages, previousSummary);

      expect(result).toBe(expectedSummary);
      expect(mockModel.doGenerateCalls).toHaveLength(1);

      // Check that the system prompt is the iterative one
      const callPrompt = mockModel.doGenerateCalls[0].prompt;
      const systemMessages = callPrompt.filter((m: any) => m.role === "system");
      const systemContent = systemMessages
        .map((m: any) => {
          if (typeof m.content === "string") {
            return m.content;
          }
          if (Array.isArray(m.content)) {
            return m.content.map((p: any) => p.text ?? "").join("");
          }
          return "";
        })
        .join("");
      expect(systemContent).toContain("iterative update");

      // Check that the user content includes the previous summary
      const userMessages = callPrompt.filter((m: any) => m.role === "user");
      const userContent = userMessages
        .map((m: any) => {
          if (typeof m.content === "string") {
            return m.content;
          }
          if (Array.isArray(m.content)) {
            return m.content.map((p: any) => p.text ?? "").join("");
          }
          return "";
        })
        .join("");
      expect(userContent).toContain("<previous-summary>");
      expect(userContent).toContain("Old conversation about weather");
      expect(userContent).toContain("Update the above summary");
    });

    it("uses default prompt when no previousSummary", async () => {
      const mockModel = createMockModel("## Summary\nFresh summary.");
      const summarizer = createModelSummarizer(mockModel);

      const messages = makeMessages({ role: "user", content: "Hello" });

      await summarizer(messages);

      const callPrompt = mockModel.doGenerateCalls[0].prompt;
      const systemMessages = callPrompt.filter((m: any) => m.role === "system");
      const systemContent = systemMessages
        .map((m: any) => {
          if (typeof m.content === "string") {
            return m.content;
          }
          if (Array.isArray(m.content)) {
            return m.content.map((p: any) => p.text ?? "").join("");
          }
          return "";
        })
        .join("");
      // Should use default prompt, not iterative
      expect(systemContent).not.toContain("iterative update");
      expect(systemContent).toContain("conversation summarizer");
    });

    it("accepts custom iterativePrompt option", async () => {
      const customIterativePrompt = "Custom iterative: merge old and new.";
      const mockModel = createMockModel("## Summary\nCustom merged.");
      const summarizer = createModelSummarizer(mockModel, {
        iterativePrompt: customIterativePrompt,
      });

      const messages = makeMessages({ role: "user", content: "New message" });

      await summarizer(messages, "Previous summary text");

      const callPrompt = mockModel.doGenerateCalls[0].prompt;
      const systemMessages = callPrompt.filter((m: any) => m.role === "system");
      const systemContent = systemMessages
        .map((m: any) => {
          if (typeof m.content === "string") {
            return m.content;
          }
          if (Array.isArray(m.content)) {
            return m.content.map((p: any) => p.text ?? "").join("");
          }
          return "";
        })
        .join("");
      expect(systemContent).toContain(customIterativePrompt);
    });

    it("return type is compatible with CompactionConfig.summarizeFn", async () => {
      const mockModel = createMockModel("## Summary\nTest.");
      const summarizeFn = createModelSummarizer(mockModel);

      // Verify it matches the updated signature
      const fn: (
        messages: ModelMessage[],
        previousSummary?: string
      ) => Promise<string> = summarizeFn;

      const result = await fn(
        [{ role: "user", content: "test" } as ModelMessage],
        "previous summary"
      );

      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("integration with MessageHistory", () => {
    it("can be used as summarizeFn in MessageHistory compaction", async () => {
      const { MessageHistory } = await import("./message-history");

      const mockModel = createMockModel(
        "## Summary\nUser discussed testing.\n\n## Context\n- Testing compaction\n\n## Current State\n- Verified integration"
      );
      const summarizeFn = createModelSummarizer(mockModel);

      const history = new MessageHistory({
        compaction: {
          enabled: true,
          maxTokens: 200,
          keepRecentTokens: 50,
          reserveTokens: 50,
          summarizeFn,
        },
      });

      // Add enough messages to trigger compaction
      for (let i = 0; i < 5; i++) {
        history.addUserMessage("x".repeat(200));
        history.addModelMessages([
          { role: "assistant" as const, content: "y".repeat(200) },
        ]);
      }

      expect(history.needsCompaction()).toBe(true);

      const didCompact = await history.compact();
      expect(didCompact).toBe(true);

      const summaries = history.getSummaries();
      expect(summaries.length).toBeGreaterThanOrEqual(1);
      expect(summaries[0].summary).toContain("## Summary");

      // Verify the model was called
      expect(mockModel.doGenerateCalls.length).toBeGreaterThan(0);

      // Verify LLM messages include the summary
      const llmMessages = history.getMessagesForLLM();
      expect(llmMessages[0].role).toBe("system");
      expect(llmMessages[0].content).toContain("## Summary");
    });
  });
});
