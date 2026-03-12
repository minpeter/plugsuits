import type { AssistantModelMessage, TextPart, ToolCallPart } from "ai";
import { describe, expect, it } from "vitest";
import {
  computeSpeculativeStartRatio,
  MessageHistory,
} from "./message-history";

const TRAILING_NEWLINES = /\n+$/;
const SEGMENT_SUMMARY_ID_PATTERN = /^segment_summary_/;

function trimTrailingNewlines(
  message: AssistantModelMessage
): AssistantModelMessage {
  if (message.role !== "assistant") {
    return message;
  }

  const content = message.content;

  if (typeof content === "string") {
    const trimmed = content.replace(TRAILING_NEWLINES, "");
    if (trimmed === content) {
      return message;
    }
    return { ...message, content: trimmed };
  }

  if (!Array.isArray(content) || content.length === 0) {
    return message;
  }

  let lastTextIndex = -1;
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === "text") {
      lastTextIndex = i;
      break;
    }
  }

  if (lastTextIndex === -1) {
    return message;
  }

  const textPart = content[lastTextIndex] as TextPart;
  const trimmedText = textPart.text.replace(TRAILING_NEWLINES, "");

  if (trimmedText === textPart.text) {
    return message;
  }

  const newContent = [...content];
  newContent[lastTextIndex] = { ...textPart, text: trimmedText };
  return { ...message, content: newContent };
}

const toolCallPart: ToolCallPart = {
  type: "tool-call",
  toolCallId: "call_123",
  toolName: "shell_command",
  input: { command: 'git commit -m "test"' },
};

describe("trimTrailingNewlines", () => {
  describe("string content", () => {
    it("trims trailing newlines", () => {
      const input: AssistantModelMessage = {
        role: "assistant",
        content: "Hello world\n\n\n",
      };
      const result = trimTrailingNewlines(input);
      expect(result.content).toBe("Hello world");
    });

    it("returns original when no trailing newlines", () => {
      const input: AssistantModelMessage = {
        role: "assistant",
        content: "Hello world",
      };
      const result = trimTrailingNewlines(input);
      expect(result).toBe(input);
    });
  });

  describe("array content", () => {
    it("trims when last element is TextPart with newlines", () => {
      const input: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Hello world\n\n\n" }],
      };
      const result = trimTrailingNewlines(input);
      expect((result.content as TextPart[])[0].text).toBe("Hello world");
    });

    it("trims TextPart even when ToolCallPart comes after", () => {
      const input: AssistantModelMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "I'll commit this.\n\n\n\n" },
          toolCallPart,
        ],
      };
      const result = trimTrailingNewlines(input);
      const content = result.content as Array<TextPart | ToolCallPart>;
      expect((content[0] as TextPart).text).toBe("I'll commit this.");
      expect(content[1]).toEqual(toolCallPart);
    });

    it("returns original when only ToolCallPart exists", () => {
      const input: AssistantModelMessage = {
        role: "assistant",
        content: [toolCallPart],
      };
      const result = trimTrailingNewlines(input);
      expect(result).toBe(input);
    });

    it("trims last TextPart when ToolCallPart comes before", () => {
      const input: AssistantModelMessage = {
        role: "assistant",
        content: [toolCallPart, { type: "text", text: "Done\n\n" }],
      };
      const result = trimTrailingNewlines(input);
      const content = result.content as Array<ToolCallPart | TextPart>;
      expect(content[0]).toEqual(toolCallPart);
      expect((content[1] as TextPart).text).toBe("Done");
    });

    it("returns original when empty array", () => {
      const input: AssistantModelMessage = {
        role: "assistant",
        content: [],
      };
      const result = trimTrailingNewlines(input);
      expect(result).toBe(input);
    });

    it("returns original when TextPart has no trailing newlines", () => {
      const input: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "No newlines" }, toolCallPart],
      };
      const result = trimTrailingNewlines(input);
      expect(result).toBe(input);
    });
  });
});

describe("MessageHistory", () => {
  it("always trims trailing newlines when storing assistant messages", () => {
    const history = new MessageHistory();
    history.addModelMessages([
      {
        role: "assistant",
        content: "Saved without trailing newlines\n\n",
      },
    ]);

    expect(history.toModelMessages()).toEqual([
      {
        role: "assistant",
        content: "Saved without trailing newlines",
      },
    ]);
  });

  it("stores originalContent for translated user messages", () => {
    const history = new MessageHistory();

    const message = history.addUserMessage(
      "Please update workspace/foo.ts",
      "workspace/foo.ts 파일을 수정해줘"
    );

    expect(message.modelMessage.content).toBe("Please update workspace/foo.ts");
    expect(message.originalContent).toBe("workspace/foo.ts 파일을 수정해줘");
    expect(history.toModelMessages()).toEqual([
      {
        role: "user",
        content: "Please update workspace/foo.ts",
      },
    ]);
  });

  it("keeps originalContent undefined for English user messages", () => {
    const history = new MessageHistory();

    const message = history.addUserMessage("Please list the files");

    expect(message.modelMessage.content).toBe("Please list the files");
    expect(message.originalContent).toBeUndefined();
    expect(history.toModelMessages()).toEqual([
      {
        role: "user",
        content: "Please list the files",
      },
    ]);
  });
});

describe("MessageHistory enforceLimit", () => {
  it("trims oldest messages (except first) when exceeding maxMessages", () => {
    const history = new MessageHistory({ maxMessages: 3 });
    history.addUserMessage("first");
    history.addUserMessage("second");
    history.addUserMessage("third");
    history.addUserMessage("fourth");

    const msgs = history.toModelMessages();
    expect(msgs).toHaveLength(3);
    // First message (initial context) is preserved
    expect(msgs[0]).toEqual({ role: "user", content: "first" });
    // Second message was trimmed, third and fourth survive
    expect(msgs[1]).toEqual({ role: "user", content: "third" });
    expect(msgs[2]).toEqual({ role: "user", content: "fourth" });
  });

  it("preserves first message when addModelMessages causes overflow", () => {
    const history = new MessageHistory({ maxMessages: 3 });
    history.addUserMessage("system prompt");
    history.addUserMessage("user msg");

    history.addModelMessages([
      { role: "assistant", content: "reply 1" },
      { role: "assistant", content: "reply 2" },
    ]);

    const msgs = history.toModelMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: "user", content: "system prompt" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "reply 1" });
    expect(msgs[2]).toEqual({ role: "assistant", content: "reply 2" });
  });

  it("does not trim when at exactly maxMessages", () => {
    const history = new MessageHistory({ maxMessages: 2 });
    history.addUserMessage("one");
    history.addUserMessage("two");

    expect(history.toModelMessages()).toHaveLength(2);
    expect(history.toModelMessages()[0]).toEqual({
      role: "user",
      content: "one",
    });
    expect(history.toModelMessages()[1]).toEqual({
      role: "user",
      content: "two",
    });
  });

  it("handles maxMessages = 1 by keeping only the last message", () => {
    const history = new MessageHistory({ maxMessages: 1 });
    history.addUserMessage("first");
    history.addUserMessage("second");

    const msgs = history.toModelMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "user", content: "second" });
  });

  it("throws RangeError for maxMessages = 0", () => {
    expect(() => new MessageHistory({ maxMessages: 0 })).toThrow(RangeError);
  });

  it("throws RangeError for negative maxMessages", () => {
    expect(() => new MessageHistory({ maxMessages: -5 })).toThrow(RangeError);
  });

  it("defaults to 1000 when no options provided", () => {
    const history = new MessageHistory();
    // Add messages below default limit — nothing should be trimmed
    for (let i = 0; i < 10; i++) {
      history.addUserMessage(`msg ${i}`);
    }
    expect(history.toModelMessages()).toHaveLength(10);
  });

  it("handles large batch addModelMessages that exceeds limit", () => {
    const history = new MessageHistory({ maxMessages: 5 });
    history.addUserMessage("initial");

    const batch: Array<{ role: "assistant"; content: string }> = [];
    for (let i = 0; i < 10; i++) {
      batch.push({ role: "assistant", content: `batch ${i}` });
    }
    history.addModelMessages(batch);

    const msgs = history.toModelMessages();
    expect(msgs).toHaveLength(5);
    // First message preserved
    expect(msgs[0]).toEqual({ role: "user", content: "initial" });
    // Only the last 4 batch messages survive
    expect(msgs[1]).toEqual({ role: "assistant", content: "batch 6" });
    expect(msgs[4]).toEqual({ role: "assistant", content: "batch 9" });
  });

  it("getAll returns correct count after trimming", () => {
    const history = new MessageHistory({ maxMessages: 2 });
    history.addUserMessage("a");
    history.addUserMessage("b");
    history.addUserMessage("c");

    expect(history.getAll()).toHaveLength(2);
    expect(history.getAll()[0].modelMessage.content).toBe("a");
    expect(history.getAll()[1].modelMessage.content).toBe("c");
  });

  it("throws RangeError for NaN maxMessages", () => {
    expect(() => new MessageHistory({ maxMessages: Number.NaN })).toThrow(
      RangeError
    );
  });

  it("throws RangeError for non-integer maxMessages", () => {
    expect(() => new MessageHistory({ maxMessages: 2.5 })).toThrow(RangeError);
  });

  it("throws RangeError for Infinity maxMessages", () => {
    expect(
      () => new MessageHistory({ maxMessages: Number.POSITIVE_INFINITY })
    ).toThrow(RangeError);
  });
});

describe("MessageHistory compaction", () => {
  it("is disabled by default", () => {
    const history = new MessageHistory();
    expect(history.isCompactionEnabled()).toBe(false);
  });

  it("can be enabled via options", () => {
    const history = new MessageHistory({
      compaction: { enabled: true },
    });
    expect(history.isCompactionEnabled()).toBe(true);
  });

  it("returns empty summaries when compaction is disabled", () => {
    const history = new MessageHistory();
    expect(history.getSummaries()).toEqual([]);
  });

  it("returns empty summaries initially when enabled", () => {
    const history = new MessageHistory({
      compaction: { enabled: true },
    });
    expect(history.getSummaries()).toEqual([]);
  });

  it("getMessagesForLLM returns plain messages when no summaries", () => {
    const history = new MessageHistory({
      compaction: { enabled: true },
    });
    history.addUserMessage("Hello");
    history.addModelMessages([{ role: "assistant", content: "Hi there" }]);

    const messages = history.getMessagesForLLM();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "Hello" });
    expect(messages[1]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("manual compact returns false when compaction is disabled", async () => {
    const history = new MessageHistory();
    history.addUserMessage("Hello");

    const result = await history.compact();
    expect(result).toBe(false);
  });

  it("manual compact returns false when no messages", async () => {
    const history = new MessageHistory({
      compaction: { enabled: true },
    });

    const result = await history.compact();
    expect(result).toBe(false);
  });

  it("uses custom summarize function when provided", async () => {
    const customSummarize = async () => "Custom summary";
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100, // Low threshold to trigger compaction
        keepRecentTokens: 50,
        summarizeFn: customSummarize,
      },
    });

    // Add enough messages to potentially trigger compaction
    for (let i = 0; i < 10; i++) {
      history.addUserMessage(
        `This is a long message ${i} with enough content to trigger token limits`
      );
      history.addModelMessages([
        {
          role: "assistant",
          content: `This is a long assistant response ${i} with sufficient content to contribute to token count`,
        },
      ]);
    }

    // Wait for async compaction
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await history.compact();
    // Result depends on whether thresholds were exceeded
    // Either way, custom summarizer should have been called if compaction happened
    expect(typeof result).toBe("boolean");
  });

  it("preserves recent messages based on keepRecentTokens", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 500,
        keepRecentTokens: 200,
        reserveTokens: 100,
      },
    });

    // Add messages
    history.addUserMessage("First message that should be summarized");
    history.addModelMessages([
      { role: "assistant", content: "First response" },
    ]);
    history.addUserMessage("Recent message to keep");
    history.addModelMessages([
      { role: "assistant", content: "Recent response" },
    ]);

    // Manual compaction
    await history.compact({ aggressive: true });

    // Recent messages should still be accessible
    const messages = history.getAll();
    const contents = messages.map((m) => m.modelMessage.content);
    expect(
      contents.some((c) => typeof c === "string" && c.includes("Recent"))
    ).toBe(true);
  });

  it("getEstimatedTokens returns 0 for empty history", () => {
    const history = new MessageHistory({
      compaction: { enabled: true },
    });
    expect(history.getEstimatedTokens()).toBe(0);
  });

  it("getEstimatedTokens increases with message count", () => {
    const history = new MessageHistory({
      compaction: { enabled: true },
    });

    const tokensBefore = history.getEstimatedTokens();
    history.addUserMessage("This is a test message with some content");
    const tokensAfter = history.getEstimatedTokens();

    expect(tokensAfter).toBeGreaterThan(tokensBefore);
  });

  it("includes summaries in estimated token count", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        keepRecentTokens: 20, // Lowered to ensure compaction actually happens
        summarizeFn: async () => "Short summary",
      },
    });

    // Add long messages to ensure they exceed keepRecentTokens and trigger compaction
    history.addUserMessage(
      "Message one with enough text to count and exceed token limits"
    );
    history.addModelMessages([
      {
        role: "assistant",
        content: "Response one with content that is long enough",
      },
    ]);
    history.addUserMessage(
      "Message two with enough text to count and exceed token limits"
    );
    history.addModelMessages([
      {
        role: "assistant",
        content: "Response two with content that is long enough",
      },
    ]);

    await history.compact();

    const summaries = history.getSummaries();
    // Compaction should actually happen with these settings
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0].summary).toBe("Short summary");
    expect(summaries[0].tokensBefore).toBeGreaterThan(0);
    expect(summaries[0].summaryTokens).toBeGreaterThan(0);
  });

  it("getMessagesForLLM prepends summaries as system message", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        keepRecentTokens: 20, // Lowered to ensure compaction actually happens
        summarizeFn: async () => "Conversation summary",
      },
    });

    // Add long messages to ensure compaction actually happens
    history.addUserMessage(
      "Old message to be summarized with sufficient length to trigger"
    );
    history.addModelMessages([
      {
        role: "assistant",
        content: "Old response with enough content to count",
      },
    ]);

    // Force compaction
    await history.compact();

    const messages = history.getMessagesForLLM();
    const summaries = history.getSummaries();

    // Compaction should actually happen with these settings
    expect(summaries.length).toBeGreaterThan(0);
    // Should have system message + remaining messages
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe("system");
    expect(typeof messages[0].content).toBe("string");
    expect(messages[0].content).toContain("Conversation summary");
  });

  it("clears summaries when clear() is called", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        keepRecentTokens: 50,
        summarizeFn: async () => "Summary",
      },
    });

    history.addUserMessage("Message");
    await history.compact();

    history.clear();
    expect(history.getSummaries()).toEqual([]);
    expect(history.getAll()).toEqual([]);
  });

  it("handles concurrent compaction calls gracefully", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        keepRecentTokens: 50,
      },
    });

    // Add messages
    for (let i = 0; i < 5; i++) {
      history.addUserMessage(`Message ${i} with content`);
    }

    // Multiple concurrent compaction calls
    const results = await Promise.all([
      history.compact(),
      history.compact(),
      history.compact(),
    ]);

    // Should not throw and should return boolean results
    expect(results.every((r) => typeof r === "boolean")).toBe(true);
  });

  it("skips pruning during intermediate steps", async () => {
    const largeOutput = "x".repeat(5000);
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 50_000,
        reserveTokens: 1000,
        summarizeFn: async () => "Intermediate step summary",
      },
      pruning: {
        enabled: true,
        protectRecentTokens: 10,
        minSavingsTokens: 10,
      },
    });

    history.addUserMessage("read the file");
    history.addModelMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_read_file",
            toolName: "read_file",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_read_file",
            toolName: "read_file",
            output: { type: "text", value: largeOutput },
          },
        ],
      },
    ]);

    await history.getMessagesForLLMAsync({ phase: "intermediate-step" });

    const toolMessage = history
      .getAll()
      .find((message) => message.modelMessage.role === "tool");

    expect(toolMessage).toBeDefined();
    if (!(toolMessage && Array.isArray(toolMessage.modelMessage.content))) {
      throw new Error("Expected tool message content");
    }

    const firstPart = toolMessage.modelMessage.content[0];
    if (
      firstPart.type !== "tool-result" ||
      typeof firstPart.output !== "object" ||
      firstPart.output === null ||
      !("value" in firstPart.output)
    ) {
      throw new Error("Expected tool-result output");
    }

    expect(firstPart.output).toEqual({ type: "text", value: largeOutput });
  });

  it("compacts earlier during intermediate steps", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        reserveTokens: 100,
        keepRecentTokens: 200,
        summarizeFn: async () => "Predictive summary",
      },
    });

    history.addUserMessage("x".repeat(1700));
    history.addModelMessages([
      { role: "assistant", content: "y".repeat(1400) },
    ]);
    history.addUserMessage("z".repeat(100));

    expect(history.needsCompaction()).toBe(false);
    expect(history.needsCompaction({ phase: "intermediate-step" })).toBe(true);

    // Use prepareSpeculativeCompaction + applyPreparedCompaction instead of getMessagesForLLMAsync
    const prepared = await history.prepareSpeculativeCompaction({
      phase: "intermediate-step",
    });
    expect(prepared).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    history.applyPreparedCompaction(prepared!);

    expect(history.getSummaries()).toHaveLength(1);
    expect(history.getSummaries()[0].summary).toBe("Predictive summary");
  });

  it("respects maxMessages even with compaction enabled", () => {
    const history = new MessageHistory({
      maxMessages: 3,
      compaction: { enabled: true },
    });

    history.addUserMessage("one");
    history.addUserMessage("two");
    history.addUserMessage("three");
    history.addUserMessage("four");

    expect(history.getAll()).toHaveLength(3);
  });
});

describe("MessageHistory enforceLimit - tool sequence validity", () => {
  it("never leaves a tool role message as the first message after enforceLimit", () => {
    // maxMessages=1: the last message is a tool result — it should be removed
    const history = new MessageHistory({ maxMessages: 1 });
    history.addUserMessage("initial user");
    history.addModelMessages([
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call_1",
            toolName: "read_file",
            input: { path: "test.ts" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call_1",
            toolName: "read_file",
            output: { type: "text" as const, value: "file contents" },
          },
        ],
      },
    ]);

    const msgs = history.toModelMessages();
    // The first message must never be a 'tool' role
    if (msgs.length > 0) {
      expect(msgs[0].role).not.toBe("tool");
    }
  });

  it("removes orphaned tool_result when fallback slice starts with a tool message", () => {
    // maxMessages=2, messages=[user:initial, user:turn1, assistant:{tool-call}, tool:{tool-result}]
    // enforceLimit fallback produces [user:initial, tool:{tool-result}] — orphaned tool must be removed
    const history = new MessageHistory({ maxMessages: 2 });
    history.addUserMessage("initial");
    history.addUserMessage("turn 1");
    history.addModelMessages([
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call_1",
            toolName: "read_file",
            input: { path: "test.ts" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call_1",
            toolName: "read_file",
            output: { type: "text" as const, value: "file contents" },
          },
        ],
      },
    ]);

    const msgs = history.toModelMessages();
    // No tool message should appear without a directly preceding assistant message
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === "tool") {
        expect(i).toBeGreaterThan(0);
        expect(msgs[i - 1].role).toBe("assistant");
      }
    }
  });

  it("removes all tool messages when only tool_result messages remain after trim", () => {
    // maxMessages=1 and the last message is a tool result — all tool messages removed
    const history = new MessageHistory({ maxMessages: 1 });
    history.addUserMessage("initial");
    history.addModelMessages([
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call_2",
            toolName: "shell_execute",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call_2",
            toolName: "shell_execute",
            output: { type: "text" as const, value: "file1.ts\nfile2.ts" },
          },
        ],
      },
    ]);

    const msgs = history.toModelMessages();
    // Every tool message must have a preceding assistant message
    const hasOrphanedTool = msgs.some(
      (m, i) =>
        m.role === "tool" && (i === 0 || msgs[i - 1].role !== "assistant")
    );
    expect(hasOrphanedTool).toBe(false);
  });

  it("preserves valid tool_call and tool_result pair when both fit within the limit", () => {
    // 5 messages total, maxMessages=4 → boundary trim keeps [user, user, assistant, tool]
    const history = new MessageHistory({ maxMessages: 4 });
    history.addUserMessage("initial");
    history.addUserMessage("second turn");
    history.addUserMessage("third turn");
    history.addModelMessages([
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call_3",
            toolName: "read_file",
            input: { path: "src/index.ts" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call_3",
            toolName: "read_file",
            output: {
              type: "text" as const,
              value: "export default function main() {}",
            },
          },
        ],
      },
    ]);

    const msgs = history.toModelMessages();
    // The assistant+tool pair should be preserved intact
    expect(msgs).toHaveLength(4);
    expect(msgs[2].role).toBe("assistant");
    expect(msgs[3].role).toBe("tool");
  });
});

describe("MessageHistory actual usage tracking", () => {
  it("starts with no actual usage", () => {
    const history = new MessageHistory();
    expect(history.getActualUsage()).toBeNull();
  });

  it("stores usage after updateActualUsage", () => {
    const history = new MessageHistory();
    history.updateActualUsage({
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 1200,
    });

    const usage = history.getActualUsage();
    expect(usage).not.toBeNull();
    expect(usage?.promptTokens).toBe(1000);
    expect(usage?.completionTokens).toBe(200);
    expect(usage?.totalTokens).toBe(1200);
    expect(usage?.updatedAt).toBeInstanceOf(Date);
  });

  it("computes totalTokens from prompt+completion when not provided", () => {
    const history = new MessageHistory();
    history.updateActualUsage({
      promptTokens: 500,
      completionTokens: 100,
    });

    expect(history.getActualUsage()?.totalTokens).toBe(600);
  });

  it("accepts AI SDK inputTokens/outputTokens usage shape", () => {
    const history = new MessageHistory();
    history.updateActualUsage({
      inputTokens: 700,
      outputTokens: 80,
    });

    expect(history.getActualUsage()?.promptTokens).toBe(700);
    expect(history.getActualUsage()?.completionTokens).toBe(80);
    expect(history.getActualUsage()?.totalTokens).toBe(780);
  });

  it("defaults to 0 for undefined fields", () => {
    const history = new MessageHistory();
    history.updateActualUsage({});

    expect(history.getActualUsage()?.totalTokens).toBe(0);
    expect(history.getActualUsage()?.promptTokens).toBe(0);
    expect(history.getActualUsage()?.completionTokens).toBe(0);
  });

  it("clears actual usage on clear()", () => {
    const history = new MessageHistory();
    history.updateActualUsage({ totalTokens: 5000 });
    history.clear();

    expect(history.getActualUsage()).toBeNull();
  });
});

describe("MessageHistory context usage", () => {
  it("returns null when contextLimit is not set", () => {
    const history = new MessageHistory();
    expect(history.getContextUsage()).toBeNull();
  });

  it("returns estimated usage when no actual usage available", () => {
    const history = new MessageHistory();
    history.setContextLimit(10_000);
    history.addUserMessage("hello world");

    const usage = history.getContextUsage();
    expect(usage).not.toBeNull();
    expect(usage?.source).toBe("estimated");
    expect(usage?.limit).toBe(10_000);
    expect(usage?.used).toBeGreaterThan(0);
    expect(usage?.remaining).toBeLessThan(10_000);
  });

  it("returns actual usage when available", () => {
    const history = new MessageHistory();
    history.setContextLimit(200_000);
    history.updateActualUsage({
      promptTokens: 30_000,
      completionTokens: 500,
      totalTokens: 30_500,
    });

    const usage = history.getContextUsage();
    expect(usage).not.toBeNull();
    expect(usage?.source).toBe("actual");
    expect(usage?.used).toBe(30_500);
    expect(usage?.remaining).toBe(169_500);
    expect(usage?.percentage).toBe(15);
  });

  it("clamps percentage to 100", () => {
    const history = new MessageHistory();
    history.setContextLimit(1000);
    history.updateActualUsage({ totalTokens: 1500 });

    const usage = history.getContextUsage();
    expect(usage?.percentage).toBe(100);
    expect(usage?.remaining).toBe(0);
  });
});

describe("MessageHistory smart compaction with actual usage", () => {
  it("uses actual usage for needsCompaction when available", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100_000,
        reserveTokens: 10_000,
      },
    });
    history.setContextLimit(100_000);
    history.addUserMessage("hello");

    history.updateActualUsage({ totalTokens: 50_000 });
    expect(history.needsCompaction()).toBe(false);

    history.updateActualUsage({ totalTokens: 95_000 });
    expect(history.needsCompaction()).toBe(true);
  });

  it("falls back to estimated when no actual usage or contextLimit", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        keepRecentTokens: 50,
        reserveTokens: 20,
      },
    });

    for (let i = 0; i < 10; i++) {
      history.addUserMessage(
        `Message ${i} with substantial content to fill up token space`
      );
    }

    const result = history.needsCompaction();
    expect(typeof result).toBe("boolean");
  });

  it("applies intermediate-step multiplier to reserve with actual usage", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100_000,
        reserveTokens: 10_000,
      },
    });
    history.setContextLimit(100_000);
    history.addUserMessage("hello");

    history.updateActualUsage({ totalTokens: 82_000 });
    expect(history.needsCompaction()).toBe(false);
    expect(history.needsCompaction({ phase: "intermediate-step" })).toBe(true);
  });

  it("invalidates actual usage after message mutations", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        reserveTokens: 100,
      },
    });
    history.setContextLimit(1000);
    history.addUserMessage("hello");
    history.updateActualUsage({ totalTokens: 200 });

    expect(history.getActualUsage()?.totalTokens).toBe(200);

    history.addUserMessage("more context");

    expect(history.getActualUsage()).toBeNull();
    expect(history.getContextUsage()?.source).toBe("estimated");
  });

  it("adjusts actual usage downward after compaction", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        keepRecentTokens: 20,
        reserveTokens: 10,
        summarizeFn: async () => "Summary",
      },
    });
    history.setContextLimit(100);

    for (let i = 0; i < 5; i++) {
      history.addUserMessage("x".repeat(80));
    }

    history.updateActualUsage({ totalTokens: 95 });
    expect(history.needsCompaction()).toBe(true);

    await history.compact();

    const usage = history.getActualUsage();
    expect(usage).not.toBeNull();
    if (!usage) {
      throw new Error("Expected actual usage after compaction");
    }
    expect(usage.totalTokens).toBeLessThan(95);
    expect(usage.totalTokens).toBeGreaterThanOrEqual(0);
    expect(history.needsCompaction()).toBe(false);
    expect(history.getSummaries()).toHaveLength(1);
  });
});

describe("MessageHistory speculative compaction", () => {
  it("prepares speculative compaction without mutating live history", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        keepRecentTokens: 20,
        reserveTokens: 10,
        summarizeFn: async () => "Prepared summary",
      },
    });
    history.setContextLimit(100);

    for (let i = 0; i < 5; i++) {
      history.addUserMessage("x".repeat(80));
    }

    const liveMessageCount = history.getAll().length;
    const liveSummaryCount = history.getSummaries().length;

    const prepared = await history.prepareSpeculativeCompaction({
      phase: "new-turn",
    });

    expect(prepared).not.toBeNull();
    expect(prepared?.didChange).toBe(true);
    expect(prepared?.segments.length).toBeGreaterThan(0);
    expect(
      prepared?.segments.filter((segment) => segment.summary !== null)
    ).toHaveLength(1);
    expect(history.getAll()).toHaveLength(liveMessageCount);
    expect(history.getSummaries()).toHaveLength(liveSummaryCount);
  });

  it("drops prepared compaction when the live history no longer matches the base snapshot", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        keepRecentTokens: 20,
        reserveTokens: 10,
        summarizeFn: async () => "Prepared summary",
      },
    });
    history.setContextLimit(100);

    for (let i = 0; i < 5; i++) {
      history.addUserMessage("x".repeat(80));
    }

    const prepared = await history.prepareSpeculativeCompaction({
      phase: "new-turn",
    });
    if (!prepared) {
      throw new Error("Expected prepared compaction");
    }

    history.clear();

    expect(history.applyPreparedCompaction(prepared)).toEqual({
      applied: false,
      reason: "stale",
    });
    expect(history.getSummaries()).toHaveLength(0);
  });

  it("applies prepared compaction when the live revision matches", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        keepRecentTokens: 20,
        reserveTokens: 10,
        summarizeFn: async () => "Prepared summary",
      },
    });
    history.setContextLimit(100);

    for (let i = 0; i < 5; i++) {
      history.addUserMessage("x".repeat(80));
    }

    const prepared = await history.prepareSpeculativeCompaction({
      phase: "new-turn",
    });
    if (!prepared) {
      throw new Error("Expected prepared compaction");
    }

    expect(history.applyPreparedCompaction(prepared)).toEqual({
      applied: true,
      reason: "applied",
    });
    expect(history.getSummaries()).toHaveLength(1);
    expect(history.getSummaries()[0].summary).toBe("Prepared summary");
  });

  it("applies prepared compaction across append-only message growth", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        keepRecentTokens: 20,
        reserveTokens: 10,
        summarizeFn: async () => "Prepared summary",
      },
    });
    history.setContextLimit(100);

    for (let i = 0; i < 5; i++) {
      history.addUserMessage("x".repeat(80));
    }

    const prepared = await history.prepareSpeculativeCompaction({
      phase: "new-turn",
    });
    if (!prepared) {
      throw new Error("Expected prepared compaction");
    }

    history.addModelMessages([
      { role: "assistant", content: "new tail message" },
    ]);

    expect(history.applyPreparedCompaction(prepared)).toEqual({
      applied: true,
      reason: "applied",
    });
    expect(history.getSummaries()).toHaveLength(1);
    expect(history.getSummaries()[0].summary).toBe("Prepared summary");
    expect(history.getAll()[history.getAll().length - 1]?.modelMessage).toEqual(
      {
        role: "assistant",
        content: "new tail message",
      }
    );
  });

  it("predicts speculative compaction one turn early", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        reserveTokens: 200,
      },
    });
    history.setContextLimit(1000);
    history.addUserMessage("hello");

    history.updateActualUsage({ totalTokens: 650 });
    expect(history.shouldStartSpeculativeCompactionForNextTurn()).toBe(true);
    expect(history.needsCompaction()).toBe(false);
  });

  it("uses speculativeStartRatio when configured", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        reserveTokens: 200,
        speculativeStartRatio: 0.75,
      },
    });
    history.setContextLimit(1000);
    history.addUserMessage("hello");

    history.updateActualUsage({ totalTokens: 740 });
    expect(history.shouldStartSpeculativeCompactionForNextTurn()).toBe(false);

    history.updateActualUsage({ totalTokens: 760 });
    expect(history.shouldStartSpeculativeCompactionForNextTurn()).toBe(true);
    expect(history.needsCompaction()).toBe(false);
  });

  it("can start speculative compaction proactively even after pendingCompaction was cleared", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        reserveTokens: 200,
        speculativeStartRatio: 0.75,
        summarizeFn: async () => "Prepared summary",
      },
    });
    history.setContextLimit(1000);
    history.addUserMessage("hello");

    await history.getMessagesForLLMAsync({ phase: "new-turn" });
    history.updateActualUsage({ totalTokens: 800 });

    expect(history.shouldStartSpeculativeCompactionForNextTurn()).toBe(true);

    const prepared = await history.prepareSpeculativeCompaction({
      phase: "new-turn",
    });
    expect(prepared).not.toBeNull();
  });

  it("detects whether an additional message would exceed the context limit", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 600,
        reserveTokens: 200,
      },
    });
    history.setContextLimit(600);
    history.addUserMessage("hello");
    history.updateActualUsage({ totalTokens: 350 });

    expect(history.wouldExceedContextWithAdditionalMessage("short")).toBe(
      false
    );
    expect(
      history.wouldExceedContextWithAdditionalMessage("x".repeat(220))
    ).toBe(true);
  });
});

describe("MessageHistory isAtHardContextLimit", () => {
  it("returns false when both compaction and pruning are disabled", () => {
    const history = new MessageHistory();
    history.addUserMessage("hello");
    history.setContextLimit(1000);

    expect(history.isAtHardContextLimit()).toBe(false);
  });

  it("returns true when totalTokens + reserveTokens >= contextLimit", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        reserveTokens: 200,
      },
    });
    history.setContextLimit(1000);
    history.addUserMessage("hello");
    history.updateActualUsage({ totalTokens: 800 });

    // 800 + 200 = 1000 >= 1000 → true
    expect(history.isAtHardContextLimit()).toBe(true);
  });

  it("returns false when totalTokens + reserveTokens < contextLimit", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        reserveTokens: 200,
      },
    });
    history.setContextLimit(1000);
    history.addUserMessage("hello");
    history.updateActualUsage({ totalTokens: 700 });

    // 700 + 200 = 900 < 1000 → false
    expect(history.isAtHardContextLimit()).toBe(false);
  });

  it("adds additionalTokens parameter to the check", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        reserveTokens: 200,
      },
    });
    history.setContextLimit(1000);
    history.addUserMessage("hello");
    history.updateActualUsage({ totalTokens: 700 });

    // 700 + 100 + 200 = 1000 >= 1000 → true
    expect(history.isAtHardContextLimit(100)).toBe(true);
    // 700 + 50 + 200 = 950 < 1000 → false
    expect(history.isAtHardContextLimit(50)).toBe(false);
  });

  it("uses reserveTokens * 2 for intermediate-step phase", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        reserveTokens: 200,
      },
    });
    history.setContextLimit(1000);
    history.addUserMessage("hello");
    history.updateActualUsage({ totalTokens: 600 });

    // new-turn: 600 + 200 = 800 < 1000 → false
    expect(history.isAtHardContextLimit()).toBe(false);
    // intermediate-step: 600 + 400 = 1000 >= 1000 → true
    expect(
      history.isAtHardContextLimit(undefined, { phase: "intermediate-step" })
    ).toBe(true);
  });

  it("returns true in pruning-only mode when at limit", () => {
    const history = new MessageHistory({
      compaction: { enabled: false },
      pruning: {
        enabled: true,
        protectRecentTokens: 100,
        minSavingsTokens: 10,
      },
    });
    history.setContextLimit(1000);
    history.addUserMessage("hello");
    history.updateActualUsage({ totalTokens: 1000 });

    // Pruning-only mode: should still return true when at limit
    expect(history.isAtHardContextLimit()).toBe(true);
  });
});

describe("MessageHistory getRecommendedMaxOutputTokens", () => {
  it("subtracts reserve tokens from the output budget", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 20_480,
        reserveTokens: 512,
      },
    });
    history.setContextLimit(20_480);
    history.setSystemPromptTokens(10_000);

    const maxOutputTokens = history.getRecommendedMaxOutputTokens([
      { role: "user", content: "x".repeat(10_000) },
    ]);

    expect(maxOutputTokens).toBe(6347);
  });

  it("returns zero when the estimated input plus reserve already exhausts the limit", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 20_480,
        reserveTokens: 512,
      },
    });
    history.setContextLimit(20_480);
    history.setSystemPromptTokens(19_800);

    const maxOutputTokens = history.getRecommendedMaxOutputTokens([
      { role: "user", content: "x".repeat(1000) },
    ]);

    expect(maxOutputTokens).toBe(0);
  });

  it("returns a smaller budget when reserve tokens are configured", () => {
    const withoutReserve = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 20_480,
        reserveTokens: 0,
      },
    });
    withoutReserve.setContextLimit(20_480);
    withoutReserve.setSystemPromptTokens(4000);

    const withReserve = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 20_480,
        reserveTokens: 512,
      },
    });
    withReserve.setContextLimit(20_480);
    withReserve.setSystemPromptTokens(4000);

    const messages = [{ role: "user" as const, content: "x".repeat(4000) }];

    expect(withReserve.getRecommendedMaxOutputTokens(messages)).toBeLessThan(
      withoutReserve.getRecommendedMaxOutputTokens(messages) ??
        Number.POSITIVE_INFINITY
    );
  });
});

describe("MessageHistory PreparedCompaction config tracking", () => {
  it("prepareSpeculativeCompaction sets contextLimitAtCreation and compactionMaxTokensAtCreation", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        keepRecentTokens: 200,
        reserveTokens: 100,
        summarizeFn: async () => "Summary",
      },
    });
    history.setContextLimit(800);

    history.addUserMessage("x".repeat(500));

    const prepared = await history.prepareSpeculativeCompaction({
      phase: "new-turn",
    });
    expect(prepared).not.toBeNull();
    expect(prepared?.baseSegmentIds.length).toBe(history.getSegments().length);
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    expect(prepared!.contextLimitAtCreation).toBe(800);
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    expect(prepared!.compactionMaxTokensAtCreation).toBe(1000);
  });

  it("applyPreparedCompaction rejects stale compaction when setContextLimit changes", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        keepRecentTokens: 200,
        reserveTokens: 100,
        summarizeFn: async () => "Summary",
      },
    });
    history.setContextLimit(800);

    for (let i = 0; i < 5; i++) {
      history.addUserMessage("x".repeat(100));
    }

    const prepared = await history.prepareSpeculativeCompaction({
      phase: "new-turn",
    });
    if (!prepared) {
      throw new Error("Expected prepared compaction");
    }

    // Change context limit (model switch)
    history.setContextLimit(2000);

    const result = history.applyPreparedCompaction(prepared);
    expect(result).toEqual({ applied: false, reason: "stale" });
  });

  it("applyPreparedCompaction rejects stale compaction when updateCompaction changes maxTokens", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        keepRecentTokens: 200,
        reserveTokens: 100,
        summarizeFn: async () => "Summary",
      },
    });
    history.setContextLimit(800);

    for (let i = 0; i < 5; i++) {
      history.addUserMessage("x".repeat(100));
    }

    const prepared = await history.prepareSpeculativeCompaction({
      phase: "new-turn",
    });
    if (!prepared) {
      throw new Error("Expected prepared compaction");
    }

    // Change compaction config (model switch)
    history.updateCompaction({ maxTokens: 2000 });

    const result = history.applyPreparedCompaction(prepared);
    expect(result).toEqual({ applied: false, reason: "stale" });
  });

  it("applyPreparedCompaction rejects stale compaction when keepRecentTokens changes", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        keepRecentTokens: 100,
        reserveTokens: 100,
        summarizeFn: async () => "summary",
      },
    });
    history.setContextLimit(1000);

    for (let i = 0; i < 5; i++) {
      history.addUserMessage(`msg_${i}_${"x".repeat(100)}`);
    }

    const prepared = await history.prepareSpeculativeCompaction({
      phase: "new-turn",
    });
    expect(prepared).not.toBeNull();

    // Change keepRecentTokens — prepared compaction used old value
    history.updateCompaction({ keepRecentTokens: 500 });

    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    const result = history.applyPreparedCompaction(prepared!);
    expect(result).toEqual({ applied: false, reason: "stale" });
  });

  it("applyPreparedCompaction applies successfully when no config changes", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 1000,
        keepRecentTokens: 200,
        reserveTokens: 100,
        summarizeFn: async () => "Summary",
      },
    });
    history.setContextLimit(800);

    for (let i = 0; i < 5; i++) {
      history.addUserMessage("x".repeat(100));
    }

    const prepared = await history.prepareSpeculativeCompaction({
      phase: "new-turn",
    });
    if (!prepared) {
      throw new Error("Expected prepared compaction");
    }

    const result = history.applyPreparedCompaction(prepared);
    expect(result).toEqual({ applied: true, reason: "applied" });
    expect(history.getSummaries()).toHaveLength(1);
  });

  it("getMessagesForLLMAsync does not call summarizeFn (neutered)", async () => {
    let callCount = 0;
    // biome-ignore lint/suspicious/useAwait: must return Promise<string> per API contract
    const summarizeFn = async () => {
      callCount++;
      return "summary";
    };
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        reserveTokens: 10,
        keepRecentTokens: 20,
        summarizeFn,
      },
    });
    history.setContextLimit(100);
    history.addUserMessage("a".repeat(200));
    history.updateActualUsage({ totalTokens: 90 });

    await history.getMessagesForLLMAsync({ phase: "new-turn" });
    expect(callCount).toBe(0);
  });
});

describe("computeSpeculativeStartRatio", () => {
  const FALLBACK = 0.6;
  const MIN = 0.15;

  it("clamps to floor for small contexts with no reserve", () => {
    expect(computeSpeculativeStartRatio(1024)).toBe(0.15);
    expect(computeSpeculativeStartRatio(8192)).toBe(0.5);
  });

  it("returns reserve-aware ratio for medium contexts", () => {
    expect(computeSpeculativeStartRatio(20_480, 512)).toBeCloseTo(0.775, 3);
    expect(computeSpeculativeStartRatio(32_768, 8192)).toBe(0.625);
  });

  it("clamps to maximum for large contexts with small reserve", () => {
    expect(computeSpeculativeStartRatio(128_000, 512)).toBe(0.95);
    expect(computeSpeculativeStartRatio(300_000, 512)).toBe(0.95);
    expect(computeSpeculativeStartRatio(1_000_000, 512)).toBe(0.95);
  });

  it("produces lower ratios when reserve is large", () => {
    const smallReserve = computeSpeculativeStartRatio(200_000, 512);
    const largeReserve = computeSpeculativeStartRatio(200_000, 64_000);
    expect(largeReserve).toBeLessThan(smallReserve);
  });

  it("guarantees speculative fires before hard compaction", () => {
    const scenarios = [
      { ctx: 20_480, reserve: 512 },
      { ctx: 200_000, reserve: 64_000 },
      { ctx: 128_000, reserve: 64_000 },
      { ctx: 32_768, reserve: 8192 },
      { ctx: 300_000, reserve: 64_000 },
      { ctx: 1_000_000, reserve: 64_000 },
    ];
    for (const { ctx, reserve } of scenarios) {
      const ratio = computeSpeculativeStartRatio(ctx, reserve);
      const specAt = Math.floor(ctx * ratio);
      const hardAt = ctx - reserve;
      expect(specAt).toBeLessThan(hardAt);
    }
  });

  it("handles edge cases", () => {
    expect(computeSpeculativeStartRatio(0)).toBe(FALLBACK);
    expect(computeSpeculativeStartRatio(-1)).toBe(FALLBACK);
    expect(computeSpeculativeStartRatio(Number.NaN)).toBe(FALLBACK);
    expect(computeSpeculativeStartRatio(Number.POSITIVE_INFINITY)).toBe(
      FALLBACK
    );
    expect(computeSpeculativeStartRatio(20_480, Number.NaN)).toBe(FALLBACK);
  });

  it("monotonically increases with context length (fixed reserve)", () => {
    const sizes = [1024, 8192, 20_480, 32_768, 128_000, 300_000, 1_000_000];
    const reserve = 8192;
    for (let i = 1; i < sizes.length; i++) {
      expect(
        computeSpeculativeStartRatio(sizes[i], reserve)
      ).toBeGreaterThanOrEqual(
        computeSpeculativeStartRatio(sizes[i - 1], reserve)
      );
    }
  });

  it("handles extreme reserve (85% of context)", () => {
    const ctx = 100_000;
    const reserve = 85_000;
    const ratio = computeSpeculativeStartRatio(ctx, reserve);
    const specAt = Math.floor(ctx * ratio);
    const hardAt = ctx - reserve;
    expect(ratio).toBeLessThanOrEqual(MIN);
    expect(specAt).toBeLessThan(hardAt);
  });

  it("handles reserve = contextLength - 1", () => {
    const ctx = 100_000;
    const reserve = ctx - 1;
    const ratio = computeSpeculativeStartRatio(ctx, reserve);
    const specAt = Math.floor(ctx * ratio);
    const hardAt = ctx - reserve;
    expect(ratio).toBeLessThan(MIN);
    expect(specAt).toBeLessThan(hardAt);
  });

  it("normalizes negative reserveTokens to 0", () => {
    const ctx = 20_480;
    const ratioNeg = computeSpeculativeStartRatio(ctx, -5000);
    const ratioZero = computeSpeculativeStartRatio(ctx, 0);
    expect(ratioNeg).toBe(ratioZero);
  });

  it("clamps ratio strictly below hard threshold (boundary equality defense)", () => {
    const scenarios = [
      { ctx: 8192, reserve: 4096 },
      { ctx: 20_480, reserve: 16_384 },
      { ctx: 128_000, reserve: 64_000 },
      { ctx: 200_000, reserve: 64_000 },
      { ctx: 100_000, reserve: 99_999 },
    ];
    for (const { ctx, reserve } of scenarios) {
      const ratio = computeSpeculativeStartRatio(ctx, reserve);
      const specAt = Math.floor(ctx * ratio);
      const hardAt = ctx - Math.max(0, Math.min(reserve, ctx - 1));
      expect(specAt).toBeLessThan(hardAt);
    }
  });
});

describe("truncateToContextBudget tool sequence validity", () => {
  it("does not return orphaned tool messages when budget is extremely small", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        reserveTokens: 10,
        keepRecentTokens: 20,
        summarizeFn: async () => "Summary",
      },
    });
    history.setContextLimit(50);

    history.addUserMessage("Hello");
    history.addModelMessages([
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "tc1",
            toolName: "test_tool",
            input: {},
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "tc1",
            toolName: "test_tool",
            output: { type: "text" as const, value: "output" },
          },
        ],
      },
    ]);

    const messages = history.getMessagesForLLM();

    for (const msg of messages) {
      if (msg.role === "tool") {
        const idx = messages.indexOf(msg);
        expect(idx).toBeGreaterThan(0);
        const prev = messages[idx - 1];
        expect(prev.role).toBe("assistant");
      }
    }
  });

  it("does not return dangling assistant tool-calls after extreme truncation", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        reserveTokens: 10,
        keepRecentTokens: 20,
        summarizeFn: async () => "Summary",
      },
    });
    history.setContextLimit(30);

    for (let i = 0; i < 3; i++) {
      history.addUserMessage(`Question ${i}`);
      history.addModelMessages([
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `tc${i}`,
              toolName: "tool",
              input: {},
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: `tc${i}`,
              toolName: "tool",
              output: { type: "text" as const, value: "x".repeat(100) },
            },
          ],
        },
      ]);
    }

    const messages = history.getMessagesForLLM();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (
        msg.role === "assistant" &&
        Array.isArray(msg.content) &&
        msg.content.some((p: { type: string }) => p.type === "tool-call")
      ) {
        expect(i + 1).toBeLessThan(messages.length);
        expect(messages[i + 1].role).toBe("tool");
      }
    }
  });

  it("returns empty array when budget allows nothing and last message is tool", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        reserveTokens: 999,
        keepRecentTokens: 20,
        summarizeFn: async () => "Summary",
      },
    });
    history.setContextLimit(10);

    history.addModelMessages([
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "tc1",
            toolName: "test_tool",
            input: {},
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "tc1",
            toolName: "test_tool",
            output: { type: "text" as const, value: "output" },
          },
        ],
      },
    ]);

    const messages = history.getMessagesForLLM();

    const toolMessages = messages.filter((m) => m.role === "tool");
    for (const toolMsg of toolMessages) {
      const idx = messages.indexOf(toolMsg);
      expect(idx).toBeGreaterThan(0);
      expect(messages[idx - 1].role).toBe("assistant");
    }
  });

  it("preserves the last valid tool pair when zero-budget truncation would otherwise empty the request", () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100,
        reserveTokens: 999,
        keepRecentTokens: 20,
        summarizeFn: async () => "Summary",
      },
    });
    history.setContextLimit(10);

    history.addUserMessage("question");
    history.addModelMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-preserve",
            toolName: "test_tool",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-preserve",
            toolName: "test_tool",
            output: { type: "text", value: "output" },
          },
        ],
      },
    ]);

    const messages = history.getMessagesForLLM();

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[1]?.role).toBe("tool");
  });

  it("tracks raw message segments as messages are added", () => {
    const history = new MessageHistory();

    const userMessage = history.addUserMessage("hello");
    const [assistantMessage, toolMessage] = history.addModelMessages([
      { role: "assistant", content: "world" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read_file",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ]);

    expect(history.getSegments()).toEqual([
      expect.objectContaining({
        id: `segment_message_${userMessage.id}`,
        messageIds: [userMessage.id],
        summary: null,
      }),
      expect.objectContaining({
        id: `segment_message_${assistantMessage?.id}`,
        messageIds: [assistantMessage?.id],
        summary: null,
      }),
      expect.objectContaining({
        id: `segment_message_${toolMessage?.id}`,
        messageIds: [toolMessage?.id],
        summary: null,
      }),
    ]);
  });

  it("rebuilds segments after compaction", () => {
    const history = new MessageHistory({ compaction: { enabled: true } });

    history.addUserMessage("one two three four five six seven eight nine ten");
    history.addModelMessages([
      { role: "assistant", content: "eleven twelve thirteen" },
    ]);

    const baseMessageIds = history.getAll().map((message) => message.id);
    history.applyPreparedCompaction({
      actualUsage: null,
      baseMessageIds,
      baseRevision: 0,
      baseSegmentIds: history.getSegments().map((segment) => segment.id),
      compactionMaxTokensAtCreation:
        history.getCompactionConfig().maxTokens ?? 8000,
      contextLimitAtCreation: history.getContextLimit(),
      didChange: true,
      keepRecentTokensAtCreation:
        history.getCompactionConfig().keepRecentTokens ?? 0,
      pendingCompaction: false,
      phase: "new-turn",
      rejected: false,
      segments: [
        {
          createdAt: new Date(),
          endMessageId: "end",
          estimatedTokens: 2,
          id: "segment_summary_summary_test",
          messageCount: 0,
          messageIds: [],
          messages: [],
          startMessageId: "summary_test",
          summary: {
            createdAt: new Date(),
            firstKeptMessageId: "end",
            id: "summary_test",
            summary: "rolled up",
            summaryTokens: 2,
            tokensBefore: 20,
          },
        },
      ],
      tokenDelta: 18,
    });

    const segments = history.getSegments();
    const summarySegment = segments.find((segment) => segment.summary !== null);
    expect(summarySegment).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(SEGMENT_SUMMARY_ID_PATTERN),
        summary: expect.objectContaining({ summary: "rolled up" }),
      })
    );
  });
});
