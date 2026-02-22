import { describe, expect, it } from "bun:test";
import { Container, type MarkdownTheme } from "@mariozechner/pi-tui";
import type { TextStreamPart, ToolSet } from "ai";
import {
  type PiTuiStreamRenderOptions,
  renderFullStreamWithPiTui,
} from "./pi-tui-stream-renderer";

type TestStreamPart = TextStreamPart<ToolSet>;

const markdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

interface RenderResult {
  output: string;
  renderCalls: number;
}

const renderParts = async (parts: TestStreamPart[]): Promise<RenderResult> => {
  const chatContainer = new Container();
  let renderCalls = 0;

  const options: PiTuiStreamRenderOptions = {
    chatContainer,
    markdownTheme,
    ui: {
      requestRender: () => {
        renderCalls += 1;
      },
    },
    showReasoning: true,
    showSteps: false,
    showFinishReason: false,
    showToolResults: true,
    showSources: false,
    showFiles: false,
  };

  async function* stream(): AsyncIterable<TestStreamPart> {
    for (const part of parts) {
      await Promise.resolve();
      yield part;
    }
  }

  await renderFullStreamWithPiTui(stream(), options);
  const output = chatContainer.render(120).join("\n");

  return { output, renderCalls };
};

describe("renderFullStreamWithPiTui", () => {
  it("streams markdown text into assistant view", async () => {
    const { output, renderCalls } = await renderParts([
      { type: "text-start", id: "text_1" },
      { type: "text-delta", id: "text_1", text: "Hello" },
      { type: "text-delta", id: "text_1", text: " world" },
      { type: "text-end", id: "text_1" },
    ]);

    expect(output).toContain("Hello world");
    expect(renderCalls).toBeGreaterThan(0);
  });

  it("preserves stream order between reasoning and text blocks", async () => {
    const { output } = await renderParts([
      { type: "reasoning-start", id: "reason_1" } as never,
      { type: "reasoning-delta", id: "reason_1", text: "First thought" },
      { type: "reasoning-end", id: "reason_1" } as never,
      { type: "text-start", id: "text_2" },
      { type: "text-delta", id: "text_2", text: "Final answer" },
      { type: "text-end", id: "text_2" },
    ]);

    const reasoningIndex = output.indexOf("First thought");
    const textIndex = output.indexOf("Final answer");

    expect(reasoningIndex).toBeGreaterThan(-1);
    expect(textIndex).toBeGreaterThan(-1);
    expect(reasoningIndex).toBeLessThan(textIndex);
  });

  it("applies Pi-like muted italic styling to reasoning text", async () => {
    const { output } = await renderParts([
      { type: "reasoning-start", id: "reason_2" } as never,
      { type: "reasoning-delta", id: "reason_2", text: "styled reasoning" },
      { type: "reasoning-end", id: "reason_2" } as never,
    ]);

    expect(output).toContain("styled reasoning");
    expect(output).toContain("\x1b[2m\x1b[3m\x1b[90m");
  });

  it("renders live diff preview for edit_file tool input", async () => {
    const { output } = await renderParts([
      {
        type: "tool-input-start",
        id: "call_edit",
        toolName: "edit_file",
      },
      {
        type: "tool-input-delta",
        id: "call_edit",
        delta:
          '{"path":"src/demo.ts","old_str":"const value = 1;","new_str":"const value = 2;"}',
      },
      { type: "tool-input-end", id: "call_edit" },
      {
        type: "tool-call",
        toolCallId: "call_edit",
        toolName: "edit_file",
        input: {
          path: "src/demo.ts",
          old_str: "const value = 1;",
          new_str: "const value = 2;",
        },
      },
    ]);

    expect(output).toContain("Live diff preview");
    expect(output).toContain("-const value = 1;");
    expect(output).toContain("+const value = 2;");
  });

  it("does not duplicate tool call blocks when input was streamed", async () => {
    const { output } = await renderParts([
      {
        type: "tool-input-start",
        id: "call_1",
        toolName: "write_file",
      },
      {
        type: "tool-input-delta",
        id: "call_1",
        delta: '{"path":"src/file.ts","content":"hello"}',
      },
      { type: "tool-input-end", id: "call_1" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "write_file",
        input: {
          path: "src/file.ts",
          content: "hello",
        },
      },
    ]);

    expect(output).toContain("call_1");
    expect((output.match(/call_1/g) ?? []).length).toBe(1);
  });

  it("supports toolCallId and inputTextDelta aliases", async () => {
    const { output } = await renderParts([
      {
        type: "tool-input-start",
        toolCallId: "call_3",
        toolName: "write_file",
      } as never,
      {
        type: "tool-input-delta",
        toolCallId: "call_3",
        inputTextDelta: '{"path":"src/big.ts","content":"chunk"}',
      } as never,
      {
        type: "tool-input-end",
        toolCallId: "call_3",
      } as never,
      {
        type: "tool-call",
        toolCallId: "call_3",
        toolName: "write_file",
        input: {
          path: "src/big.ts",
          content: "chunk",
        },
      } as never,
    ]);

    expect(output).toContain("call_3");
    expect(output).toContain("src/big.ts");
  });
});
