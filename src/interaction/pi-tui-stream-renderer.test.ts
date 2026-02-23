import { describe, expect, it } from "bun:test";
import { Container, type MarkdownTheme } from "@mariozechner/pi-tui";
import type { TextStreamPart, ToolSet } from "ai";
import { computeLineHash } from "../tools/utils/hashline/hashline";
import {
  type PiTuiStreamRenderOptions,
  renderFullStreamWithPiTui,
} from "./pi-tui-stream-renderer";

type TestStreamPart = TextStreamPart<ToolSet>;

const LARGE_BLANK_GAP_REGEX = /\n[ \t]*\n[ \t]*\n[ \t]*\n/;
const tagGrepLine = (path: string, lineNumber: number, content: string): string => {
  return `${path}:${lineNumber}#${computeLineHash(lineNumber, content)} | ${content}`;
};
const findLastLineIndexContaining = (
  lines: string[],
  predicate: (line: string) => boolean,
  beforeIndex: number
): number => {
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    if (predicate(lines[i])) {
      return i;
    }
  }

  return -1;
};

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

interface RenderPartsOptions {
  onFirstVisiblePart?: () => void;
  showRawToolIo?: boolean;
}

const renderParts = async (
  parts: TestStreamPart[],
  overrides: RenderPartsOptions = {}
): Promise<RenderResult> => {
  const chatContainer = new Container();
  let renderCalls = 0;

  const options: PiTuiStreamRenderOptions = {
    chatContainer,
    markdownTheme,
    onFirstVisiblePart: overrides.onFirstVisiblePart,
    ui: {
      requestRender: () => {
        renderCalls += 1;
      },
    },
    showReasoning: true,
    showSteps: false,
    showFinishReason: false,
    showToolResults: true,
    showRawToolIo: overrides.showRawToolIo,
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
  it("calls onFirstVisiblePart exactly once", async () => {
    let calls = 0;

    await renderParts(
      [
        { type: "start" } as never,
        { type: "text-start", id: "text_1" },
        { type: "text-delta", id: "text_1", text: "Hello" },
        { type: "text-delta", id: "text_1", text: " world" },
        { type: "text-end", id: "text_1" },
      ],
      {
        onFirstVisiblePart: () => {
          calls += 1;
        },
      }
    );

    expect(calls).toBe(1);
  });

  it("does not call onFirstVisiblePart for ignored-only stream", async () => {
    let calls = 0;

    await renderParts(
      [
        { type: "start" } as never,
        { type: "text-end", id: "text_1" },
        { type: "reasoning-end", id: "reason_1" } as never,
        { type: "abort" } as never,
      ],
      {
        onFirstVisiblePart: () => {
          calls += 1;
        },
      }
    );

    expect(calls).toBe(0);
  });

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

  it("removes leading newlines from reasoning display", async () => {
    const { output } = await renderParts([
      { type: "reasoning-start", id: "reason_trim" } as never,
      {
        type: "reasoning-delta",
        id: "reason_trim",
        text: "\n\nreasoning without top blank lines",
      },
      { type: "reasoning-end", id: "reason_trim" } as never,
    ]);

    expect(output).toContain("reasoning without top blank lines");
    expect(output).not.toContain("\x1b[2m\x1b[3m\x1b[90m\n");
  });

  it("avoids large gap between tool output and following reasoning", async () => {
    const { output } = await renderParts([
      {
        type: "tool-call",
        toolCallId: "call_gap",
        toolName: "bash",
        input: {
          command: "pwd",
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_gap",
        toolName: "bash",
        input: {
          command: "pwd",
        },
        output: "tool output line\n\n\n",
      },
      { type: "reasoning-start", id: "reason_gap" } as never,
      {
        type: "reasoning-delta",
        id: "reason_gap",
        text: "After tool output",
      },
      { type: "reasoning-end", id: "reason_gap" } as never,
    ]);

    const plain = output;
    const start = plain.indexOf("tool output line");
    const end = plain.indexOf("After tool output");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const between = plain.slice(start, end);
    expect(between).not.toMatch(LARGE_BLANK_GAP_REGEX);

    const lines = plain.split("\n");
    const reasoningLineIndex = lines.findIndex((line) =>
      line.includes("After tool output")
    );
    expect(reasoningLineIndex).toBeGreaterThan(-1);

    const outputFenceIndex = findLastLineIndexContaining(
      lines,
      (line) => line.trim() === "```",
      reasoningLineIndex
    );
    expect(outputFenceIndex).toBeGreaterThan(-1);
    expect(reasoningLineIndex).toBe(outputFenceIndex + 1);
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

  it("renders read_file output as structured markdown", async () => {
    const readOutput = [
      "OK - read file",
      "path: src/demo.ts",
      "bytes: 48",
      "last_modified: 2026-01-19T03:33:57.520Z",
      "lines: 5 (returned: 4)",
      "range: L2-L5",
      "truncated: true",
      "",
      "======== demo.ts L2-L5 ========",
      "   2 | const value = 2;",
      "   3 | export { value };",
      "   4 | ```md",
      "   5 | ![Image 1](./img.png)",
      "======== end ========",
    ].join("\n");

    const { output } = await renderParts([
      {
        type: "tool-call",
        toolCallId: "call_read",
        toolName: "read_file",
        input: {
          path: "src/demo.ts",
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_read",
        toolName: "read_file",
        input: {
          path: "src/demo.ts",
        },
        output: readOutput,
      },
    ]);

    expect(output).toContain("Read src/demo.ts L2-L5");
    expect(output).toContain("2 | ");
    expect(output).toContain("const value = 2;");
    expect(output).toContain("![Image 1](./img.png)");
    expect(output).toContain("... (1 more line, truncated)");
    expect(output).not.toContain("4 | ```md");
    expect(output).not.toContain("```md");
    expect(output).not.toContain("Tool read_file");
    expect(output).not.toContain("Output");
    expect(output).not.toContain("OK - read file");
  });

  it("omits read_file content after 10 lines", async () => {
    const numberedLines = Array.from({ length: 12 }, (_, index) => {
      const lineNumber = index + 1;
      return `${lineNumber.toString().padStart(4, " ")} | line ${lineNumber}`;
    });

    const readOutput = [
      "OK - read file",
      "path: src/long.txt",
      "bytes: 120",
      "last_modified: 2026-02-23T01:00:00.000Z",
      "lines: 12 (returned: 12)",
      "range: L1-L12",
      "truncated: false",
      "",
      "======== long.txt L1-L12 ========",
      ...numberedLines,
      "======== end ========",
    ].join("\n");

    const { output } = await renderParts([
      {
        type: "tool-call",
        toolCallId: "call_long",
        toolName: "read_file",
        input: {
          path: "src/long.txt",
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_long",
        toolName: "read_file",
        input: {
          path: "src/long.txt",
        },
        output: readOutput,
      },
    ]);

    expect(output).toContain("Read src/long.txt L1-L12");
    expect(output).toContain("10 | line 10");
    expect(output).not.toContain("11 | line 11");
    expect(output).toContain("... (2 more lines)");
  });

  it("truncates long read_file lines instead of wrapping", async () => {
    const longTail = "X".repeat(180);
    const readOutput = [
      "OK - read file",
      "path: src/wrap.txt",
      "bytes: 999",
      "last_modified: 2026-02-23T01:00:00.000Z",
      "lines: 1 (returned: 1)",
      "range: L1-L1",
      "truncated: false",
      "",
      "======== wrap.txt L1-L1 ========",
      `   1 | prefix ${longTail}`,
      "======== end ========",
    ].join("\n");

    const { output } = await renderParts([
      {
        type: "tool-call",
        toolCallId: "call_wrap",
        toolName: "read_file",
        input: {
          path: "src/wrap.txt",
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_wrap",
        toolName: "read_file",
        input: {
          path: "src/wrap.txt",
        },
        output: readOutput,
      },
    ]);

    expect(output).toContain("Read src/wrap.txt L1-L1");
    expect(output).toContain("1 | prefix");
    expect(output).not.toContain(longTail);
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

  it("keeps reasoning visible after tool blocks in stream order", async () => {
    const { output } = await renderParts([
      { type: "reasoning-start", id: "reason_before" } as never,
      { type: "reasoning-delta", id: "reason_before", text: "Before tool" },
      { type: "reasoning-end", id: "reason_before" } as never,
      {
        type: "tool-input-start",
        id: "call_reason",
        toolName: "bash",
      },
      {
        type: "tool-input-delta",
        id: "call_reason",
        delta: '{"command":"ls"}',
      },
      { type: "tool-input-end", id: "call_reason" },
      {
        type: "tool-call",
        toolCallId: "call_reason",
        toolName: "bash",
        input: {
          command: "ls",
        },
      },
      { type: "reasoning-start", id: "reason_after" } as never,
      { type: "reasoning-delta", id: "reason_after", text: "After tool" },
      { type: "reasoning-end", id: "reason_after" } as never,
    ]);

    const beforeIndex = output.indexOf("Before tool");
    const toolIndex = output.indexOf("call_reason");
    const afterIndex = output.indexOf("After tool");

    expect(beforeIndex).toBeGreaterThan(-1);
    expect(toolIndex).toBeGreaterThan(-1);
    expect(afterIndex).toBeGreaterThan(-1);
    expect(beforeIndex).toBeLessThan(toolIndex);
    expect(toolIndex).toBeLessThan(afterIndex);
  });

  it("keeps reasoning visible between two tool calls", async () => {
    const { output } = await renderParts([
      {
        type: "tool-input-start",
        id: "call_a",
        toolName: "bash",
      },
      {
        type: "tool-input-delta",
        id: "call_a",
        delta: '{"command":"pwd"}',
      },
      { type: "tool-input-end", id: "call_a" },
      {
        type: "tool-call",
        toolCallId: "call_a",
        toolName: "bash",
        input: {
          command: "pwd",
        },
      },
      { type: "reasoning-start", id: "reason_mid" } as never,
      { type: "reasoning-delta", id: "reason_mid", text: "Between tools" },
      { type: "reasoning-end", id: "reason_mid" } as never,
      {
        type: "tool-input-start",
        id: "call_b",
        toolName: "bash",
      },
      {
        type: "tool-input-delta",
        id: "call_b",
        delta: '{"command":"ls"}',
      },
      { type: "tool-input-end", id: "call_b" },
      {
        type: "tool-call",
        toolCallId: "call_b",
        toolName: "bash",
        input: {
          command: "ls",
        },
      },
    ]);

    const firstToolIndex = output.indexOf("call_a");
    const reasoningIndex = output.indexOf("Between tools");
    const secondToolIndex = output.indexOf("call_b");

    expect(firstToolIndex).toBeGreaterThan(-1);
    expect(reasoningIndex).toBeGreaterThan(-1);
    expect(secondToolIndex).toBeGreaterThan(-1);
    expect(firstToolIndex).toBeLessThan(reasoningIndex);
    expect(reasoningIndex).toBeLessThan(secondToolIndex);
  });

  it("keeps reasoning visible across unknown stream parts", async () => {
    const { output } = await renderParts([
      { type: "reasoning-start", id: "reason_unknown_before" } as never,
      {
        type: "reasoning-delta",
        id: "reason_unknown_before",
        text: "Before unknown",
      },
      { type: "reasoning-end", id: "reason_unknown_before" } as never,
      {
        type: "unknown-x",
        payload: "mystery",
      } as never,
      { type: "reasoning-start", id: "reason_unknown_after" } as never,
      {
        type: "reasoning-delta",
        id: "reason_unknown_after",
        text: "After unknown",
      },
      { type: "reasoning-end", id: "reason_unknown_after" } as never,
    ]);

    const beforeIndex = output.indexOf("Before unknown");
    const unknownIndex = output.indexOf("[unknown part]");
    const afterIndex = output.indexOf("After unknown");

    expect(beforeIndex).toBeGreaterThan(-1);
    expect(unknownIndex).toBeGreaterThan(-1);
    expect(afterIndex).toBeGreaterThan(-1);
    expect(beforeIndex).toBeLessThan(unknownIndex);
    expect(unknownIndex).toBeLessThan(afterIndex);
  });

  it("renders glob_files output as structured markdown", async () => {
    const globOutput = [
      "OK - glob",
      'pattern: "src/**/*.ts"',
      "path: /project",
      "respect_git_ignore: true",
      "file_count: 12",
      "truncated: false",
      "sorted_by: mtime desc",
      "",
      "======== glob results ========",
      "/project/file1.ts",
      "/project/file2.ts",
      "/project/file3.ts",
      "/project/file4.ts",
      "/project/file5.ts",
      "/project/file6.ts",
      "/project/file7.ts",
      "/project/file8.ts",
      "/project/file9.ts",
      "/project/file10.ts",
      "/project/file11.ts",
      "/project/file12.ts",
      "======== end ========",
    ].join("\n");

    const { output } = await renderParts([
      {
        type: "tool-call",
        toolCallId: "call_glob",
        toolName: "glob_files",
        input: {
          pattern: "src/**/*.ts",
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_glob",
        toolName: "glob_files",
        input: {
          pattern: "src/**/*.ts",
        },
        output: globOutput,
      },
    ]);

    expect(output).toContain("Glob src/**/*.ts");
    expect(output).toContain("/project/file1.ts");
    expect(output).toContain("... (2 more lines)");
    expect(output).not.toContain("Tool glob_files");
    expect(output).not.toContain("Output");
  });

  it("renders glob_files no-match output in glob mode", async () => {
    const globOutput = [
      "OK - glob (no matches)",
      'pattern: "*.xyz"',
      "path: /project",
      "respect_git_ignore: true",
      "file_count: 0",
      "truncated: false",
      "sorted_by: mtime desc",
      "",
      "======== glob results ========",
      "(no matches)",
      "======== end ========",
    ].join("\n");

    const { output } = await renderParts([
      {
        type: "tool-call",
        toolCallId: "call_glob_empty",
        toolName: "glob_files",
        input: {
          pattern: "*.xyz",
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_glob_empty",
        toolName: "glob_files",
        input: {
          pattern: "*.xyz",
        },
        output: globOutput,
      },
    ]);

    expect(output).toContain("Glob *.xyz");
    expect(output).toContain("(no matches)");
    expect(output).not.toContain("Tool glob_files");
    expect(output).not.toContain("Output");
  });

  it("shows truncated marker for glob files when model truncates", async () => {
    const globOutput = [
      "OK - glob",
      'pattern: "src/**/*.ts"',
      "path: /project",
      "respect_git_ignore: true",
      "file_count: 12",
      "truncated: true",
      "sorted_by: mtime desc",
      "",
      "======== glob results ========",
      "/project/file1.ts",
      "/project/file2.ts",
      "/project/file3.ts",
      "/project/file4.ts",
      "/project/file5.ts",
      "/project/file6.ts",
      "/project/file7.ts",
      "/project/file8.ts",
      "/project/file9.ts",
      "/project/file10.ts",
      "/project/file11.ts",
      "/project/file12.ts",
      "======== end ========",
    ].join("\n");

    const { output } = await renderParts([
      {
        type: "tool-call",
        toolCallId: "call_glob_truncated",
        toolName: "glob_files",
        input: {
          pattern: "src/**/*.ts",
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_glob_truncated",
        toolName: "glob_files",
        input: {
          pattern: "src/**/*.ts",
        },
        output: globOutput,
      },
    ]);

    expect(output).toContain("... (2 more lines, truncated)");
    expect(output).not.toContain("file_count (");
    expect(output).not.toContain("path: ");
  });

  it("renders grep_files output as structured markdown", async () => {
    const grepOutput = [
      "OK - grep",
      'pattern: "foo"',
      "path: /project",
      "include: *.ts",
      "case_sensitive: false",
      "fixed_strings: false",
      "match_count: 12",
      "truncated: false",
      "",
      "======== grep results ========",
      tagGrepLine("/project/a.ts", 1, "const foo = 1;"),
      tagGrepLine("/project/b.ts", 2, "const foo = 2;"),
      tagGrepLine("/project/c.ts", 3, "const foo = 3;"),
      tagGrepLine("/project/d.ts", 4, "const foo = 4;"),
      tagGrepLine("/project/e.ts", 5, "const foo = 5;"),
      tagGrepLine("/project/f.ts", 6, "const foo = 6;"),
      tagGrepLine("/project/g.ts", 7, "const foo = 7;"),
      tagGrepLine("/project/h.ts", 8, "const foo = 8;"),
      tagGrepLine("/project/i.ts", 9, "const foo = 9;"),
      tagGrepLine("/project/j.ts", 10, "const foo = 10;"),
      tagGrepLine("/project/k.ts", 11, "const foo = 11;"),
      tagGrepLine("/project/l.ts", 12, "const foo = 12;"),
      "======== end ========",
    ].join("\n");

    const { output } = await renderParts([
      {
        type: "tool-call",
        toolCallId: "call_grep",
        toolName: "grep_files",
        input: {
          pattern: "foo",
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_grep",
        toolName: "grep_files",
        input: {
          pattern: "foo",
        },
        output: grepOutput,
      },
    ]);

    expect(output).toContain("Grep foo");
    expect(output).toContain(tagGrepLine("/project/a.ts", 1, "const foo = 1;"));
    expect(output).toContain("... (2 more lines)");
    expect(output).not.toContain("Tool grep_files");
    expect(output).not.toContain("Output");
  });

  it("renders grep_files no-match output in grep mode", async () => {
    const grepOutput = [
      "OK - grep (no matches)",
      'pattern: "foo"',
      "path: /project",
      "include: *.ts",
      "case_sensitive: false",
      "fixed_strings: false",
      "match_count: 0",
      "truncated: false",
      "",
      "======== grep results ========",
      "(no matches)",
      "======== end ========",
    ].join("\n");

    const { output } = await renderParts([
      {
        type: "tool-call",
        toolCallId: "call_grep_empty",
        toolName: "grep_files",
        input: {
          pattern: "foo",
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_grep_empty",
        toolName: "grep_files",
        input: {
          pattern: "foo",
        },
        output: grepOutput,
      },
    ]);

    expect(output).toContain("Grep foo");
    expect(output).toContain("(no matches)");
    expect(output).not.toContain("Tool grep_files");
    expect(output).not.toContain("Output");
  });

  it("shows truncated marker for grep files when model truncates", async () => {
    const grepOutput = [
      "OK - grep",
      'pattern: "foo"',
      "path: /project",
      "include: *.ts",
      "case_sensitive: false",
      "fixed_strings: false",
      "match_count: 40",
      "truncated: true",
      "",
      "======== grep results ========",
      tagGrepLine("/project/a.ts", 1, "const foo = 1;"),
      tagGrepLine("/project/b.ts", 2, "const foo = 2;"),
      tagGrepLine("/project/c.ts", 3, "const foo = 3;"),
      tagGrepLine("/project/d.ts", 4, "const foo = 4;"),
      tagGrepLine("/project/e.ts", 5, "const foo = 5;"),
      tagGrepLine("/project/f.ts", 6, "const foo = 6;"),
      tagGrepLine("/project/g.ts", 7, "const foo = 7;"),
      tagGrepLine("/project/h.ts", 8, "const foo = 8;"),
      tagGrepLine("/project/i.ts", 9, "const foo = 9;"),
      tagGrepLine("/project/j.ts", 10, "const foo = 10;"),
      tagGrepLine("/project/k.ts", 11, "const foo = 11;"),
      tagGrepLine("/project/l.ts", 12, "const foo = 12;"),
      "======== end ========",
    ].join("\n");

    const { output } = await renderParts([
      {
        type: "tool-call",
        toolCallId: "call_grep_truncated",
        toolName: "grep_files",
        input: {
          pattern: "foo",
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_grep_truncated",
        toolName: "grep_files",
        input: {
          pattern: "foo",
        },
        output: grepOutput,
      },
    ]);

    expect(output).toContain("... (30 more lines, truncated)");
    expect(output).toContain("match_count (40)");
    expect(output).toContain("truncated: true");
  });

  it("renders read/glob/grep tool IO in raw mode when enabled", async () => {
    const cases = [
      {
        toolCallId: "call_read_raw",
        toolName: "read_file",
        input: { path: "src/demo.ts" },
        output: [
          "OK - read file",
          "path: src/demo.ts",
          "bytes: 12",
          "last_modified: 2026-02-23T01:00:00.000Z",
          "lines: 1 (returned: 1)",
          "range: L1-L1",
          "truncated: false",
          "",
          "======== demo.ts L1-L1 ========",
          "   1 | const x = 1;",
          "======== end ========",
        ].join("\n"),
        prettyHeading: "Read src/demo.ts",
      },
      {
        toolCallId: "call_glob_raw",
        toolName: "glob_files",
        input: { pattern: "src/**/*.ts" },
        output: [
          "OK - glob",
          'pattern: "src/**/*.ts"',
          "path: /project",
          "respect_git_ignore: true",
          "file_count: 1",
          "truncated: false",
          "sorted_by: mtime desc",
          "",
          "======== glob results ========",
          "/project/file1.ts",
          "======== end ========",
        ].join("\n"),
        prettyHeading: "Glob src/**/*.ts",
      },
      {
        toolCallId: "call_grep_raw",
        toolName: "grep_files",
        input: { pattern: "foo" },
        output: [
          "OK - grep",
          'pattern: "foo"',
          "path: /project",
          "include: *.ts",
          "case_sensitive: false",
          "fixed_strings: false",
          "match_count: 1",
          "truncated: false",
          "",
          "======== grep results ========",
          tagGrepLine("/project/file1.ts", 1, "const foo = 1;"),
          "======== end ========",
        ].join("\n"),
        prettyHeading: "Grep foo",
      },
    ] as const;

    for (const testCase of cases) {
      const { output } = await renderParts(
        [
          {
            type: "tool-call",
            toolCallId: testCase.toolCallId,
            toolName: testCase.toolName,
            input: testCase.input,
          },
          {
            type: "tool-result",
            toolCallId: testCase.toolCallId,
            toolName: testCase.toolName,
            input: testCase.input,
            output: testCase.output,
          },
        ],
        { showRawToolIo: true }
      );

      expect(output).toContain(`Tool ${testCase.toolName}`);
      expect(output).toContain("Input");
      expect(output).toContain("Output");
      expect(output).toContain(testCase.output.split("\n")[0]);
      expect(output).not.toContain(testCase.prettyHeading);
    }
  });
});
