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
