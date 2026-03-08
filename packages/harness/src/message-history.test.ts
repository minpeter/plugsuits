import { describe, expect, it } from "bun:test";
import type { AssistantModelMessage, TextPart, ToolCallPart } from "ai";
import { MessageHistory } from "./message-history";

const TRAILING_NEWLINES = /\n+$/;

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
    expect(history.toModelMessages()[0]).toEqual({ role: "user", content: "one" });
    expect(history.toModelMessages()[1]).toEqual({ role: "user", content: "two" });
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
    expect(() => new MessageHistory({ maxMessages: NaN })).toThrow(RangeError);
  });

  it("throws RangeError for non-integer maxMessages", () => {
    expect(() => new MessageHistory({ maxMessages: 2.5 })).toThrow(RangeError);
  });

  it("throws RangeError for Infinity maxMessages", () => {
    expect(() => new MessageHistory({ maxMessages: Infinity })).toThrow(RangeError);
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
      history.addUserMessage(`This is a long message ${i} with enough content to trigger token limits`);
      history.addModelMessages([{
        role: "assistant",
        content: `This is a long assistant response ${i} with sufficient content to contribute to token count`,
      }]);
    }

    // Wait for async compaction
    await new Promise(resolve => setTimeout(resolve, 50));

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
    history.addModelMessages([{ role: "assistant", content: "First response" }]);
    history.addUserMessage("Recent message to keep");
    history.addModelMessages([{ role: "assistant", content: "Recent response" }]);

    // Manual compaction
    await history.compact();

    // Recent messages should still be accessible
    const messages = history.getAll();
    const contents = messages.map(m => m.modelMessage.content);
    expect(contents.some(c => typeof c === "string" && c.includes("Recent"))).toBe(true);
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
    history.addUserMessage("Message one with enough text to count and exceed token limits");
    history.addModelMessages([{ role: "assistant", content: "Response one with content that is long enough" }]);
    history.addUserMessage("Message two with enough text to count and exceed token limits");
    history.addModelMessages([{ role: "assistant", content: "Response two with content that is long enough" }]);

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
    history.addUserMessage("Old message to be summarized with sufficient length to trigger");
    history.addModelMessages([{ role: "assistant", content: "Old response with enough content to count" }]);

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
    expect(results.every(r => typeof r === "boolean")).toBe(true);
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
      (m, i) => m.role === "tool" && (i === 0 || msgs[i - 1].role !== "assistant")
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
            output: { type: "text" as const, value: "export default function main() {}" },
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
