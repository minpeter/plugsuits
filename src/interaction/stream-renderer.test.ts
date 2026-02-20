import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import type { TextStreamPart, ToolSet } from "ai";
import { renderFullStream } from "./stream-renderer";

type TestStreamPart = TextStreamPart<ToolSet>;

const renderParts = async (parts: TestStreamPart[]): Promise<string> => {
  let output = "";

  const writable = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });

  async function* stream(): AsyncIterable<TestStreamPart> {
    for (const part of parts) {
      await Promise.resolve();
      yield part;
    }
  }

  await renderFullStream(stream(), {
    output: writable,
    showReasoning: false,
    showSteps: false,
    showFinishReason: false,
    showToolResults: true,
    showSources: false,
    showFiles: false,
    useColor: false,
    smoothStream: false,
  });

  return output;
};

describe("renderFullStream tool input streaming", () => {
  it("renders tool-input-delta in real time and avoids duplicate tool-call input", async () => {
    const output = await renderParts([
      {
        type: "tool-input-start",
        id: "call_1",
        toolName: "write_file",
      },
      {
        type: "tool-input-delta",
        id: "call_1",
        delta: '{"path":"src/big.ts",',
      },
      {
        type: "tool-input-delta",
        id: "call_1",
        delta: '"content":"chunk"}',
      },
      {
        type: "tool-input-end",
        id: "call_1",
      },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "write_file",
        input: {
          path: "src/big.ts",
          content: "chunk",
        },
      },
    ]);

    expect(output).toContain(
      'tool write_file (call_1)\ninput: {"path":"src/big.ts","content":"chunk"}\n'
    );
    expect(output).not.toContain('  "path": "src/big.ts"');
    expect((output.match(/tool write_file \(call_1\)/g) ?? []).length).toBe(1);
  });

  it("supports toolCallId and inputTextDelta from AI SDK tool-input deltas", async () => {
    const output = await renderParts([
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

    expect(output).toContain(
      'tool write_file (call_3)\ninput: {"path":"src/big.ts","content":"chunk"}\n'
    );
    expect((output.match(/tool write_file \(call_3\)/g) ?? []).length).toBe(1);
  });

  it("keeps existing tool-call rendering when no tool-input-delta exists", async () => {
    const output = await renderParts([
      {
        type: "tool-call",
        toolCallId: "call_2",
        toolName: "bash",
        input: {
          command: "ls -la",
        },
      },
    ]);

    expect(output).toContain("tool bash (call_2)");
    expect(output).toContain('"command": "ls -la"');
  });

  it("renders tool-call input when tool-input stream has no deltas", async () => {
    const output = await renderParts([
      {
        type: "tool-input-start",
        id: "call_4",
        toolName: "bash",
      },
      {
        type: "tool-input-end",
        id: "call_4",
      },
      {
        type: "tool-call",
        toolCallId: "call_4",
        toolName: "bash",
        input: {
          command: "ls -la",
        },
      },
    ]);

    expect((output.match(/tool bash \(call_4\)/g) ?? []).length).toBe(1);
    expect(output).toContain("tool bash (call_4)");
    expect(output).toContain('"command": "ls -la"');
  });
});
