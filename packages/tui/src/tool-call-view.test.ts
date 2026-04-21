import type { MarkdownTheme } from "@mariozechner/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseToolCallView } from "./tool-call-view";

const markdownTheme: MarkdownTheme = {
  heading: (t) => t,
  link: (t) => t,
  linkUrl: (t) => t,
  code: (t) => t,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => t,
  quote: (t) => t,
  quoteBorder: (t) => t,
  hr: (t) => t,
  listBullet: (t) => t,
  bold: (t) => t,
  italic: (t) => t,
  strikethrough: (t) => t,
  underline: (t) => t,
};

const BRAILLE_SPINNER_GLYPHS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

describe("BaseToolCallView rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const renderView = (view: BaseToolCallView): string =>
    view.render(120).join("\n");

  it("does not render an inline Executing indicator (moved to the foreground spinner)", () => {
    const view = new BaseToolCallView(
      "call_1",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls -la" });

    expect(renderView(view)).not.toContain("Executing...");

    view.dispose();
  });

  it("renders tool input without leaving trailing blank lines", () => {
    const view = new BaseToolCallView(
      "call_2",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls" });

    const lines = view.render(120);
    expect(lines.length).toBeGreaterThan(0);
    const lastLine = lines.at(-1) ?? "";
    expect(lastLine.trim().length).toBeGreaterThan(0);

    view.dispose();
  });

  it("renders tool output after it lands", () => {
    const view = new BaseToolCallView(
      "call_3",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls" });
    view.setOutput("file-a\nfile-b\n");

    const output = renderView(view);
    expect(output).toContain("file-a");
    expect(output).toContain("file-b");

    view.dispose();
  });

  it("does not append a trailing blank line in pretty-block pending mode", () => {
    const view = new BaseToolCallView(
      "call_pretty_pending",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls" });
    view.setPrettyBlock("**Shell** `ls`", "", {
      isPending: true,
      useBackground: false,
    });

    const lines = view.render(80);
    expect(lines.length).toBeGreaterThan(0);
    const lastLine = lines.at(-1) ?? "";
    expect(lastLine.trim().length).toBeGreaterThan(0);

    view.dispose();
  });

  it("keeps one blank line between header and body in pretty-block non-pending mode", () => {
    const view = new BaseToolCallView(
      "call_pretty_full",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls" });
    view.setOutput("a\nb");
    view.setPrettyBlock("**Shell** `ls`", "a\nb", { useBackground: false });

    const lines = view.render(80);
    const bodyFirstIdx = lines.findIndex((line) => line.includes("a"));
    expect(bodyFirstIdx).toBeGreaterThan(0);
    const lineBeforeBody = lines[bodyFirstIdx - 1] ?? "";
    expect(lineBeforeBody.trim().length).toBe(0);

    view.dispose();
  });
});

const collapseBlankLines = (lines: string[]): string[] =>
  lines.map((line) => (line.trim().length === 0 ? "" : line.trimEnd()));

describe("BaseToolCallView render shape fixtures", () => {
  // Regression: pretty-block pending used to paint an internal "Executing..."
  // spinner into readBody, which competed with the foreground spinner.
  it("pretty-block pending mode renders only the header — no body, no trailing blank, no Executing", () => {
    const view = new BaseToolCallView(
      "call_px_pending",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls" });
    view.setPrettyBlock("**Shell** `ls`", "", {
      isPending: true,
      useBackground: false,
    });

    const lines = collapseBlankLines(view.render(80));

    expect(lines).toMatchInlineSnapshot(`
      [
        " Shell ls",
      ]
    `);
    expect(lines.join("\n")).not.toContain("Executing");
  });

  // Regression: ensurePrettyBlockComponents used to keep a standalone Spacer(1)
  // between header and body, which emitted [""] even when the body was empty,
  // producing a ghost blank line above the foreground spinner.
  it("pretty-block non-pending mode renders [header, blank, body] — no trailing blank", () => {
    const view = new BaseToolCallView(
      "call_px_full",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls" });
    view.setOutput("a\nb\nc");
    view.setPrettyBlock("**Shell** `ls`", "a\nb\nc", { useBackground: false });

    const lines = collapseBlankLines(view.render(80));

    expect(lines).toMatchInlineSnapshot(`
      [
        " Shell ls",
        "",
        " a",
        " b",
        " c",
      ]
    `);
  });

  // Regression: BaseToolCallView used to render an inline "Executing..." Text
  // child, which sat inside chatContainer far from the editor and clashed
  // with the idle placeholder's two blank lines.
  it("raw fallback path never emits 'Executing' — pending affordance lives in foreground spinner", () => {
    const view = new BaseToolCallView(
      "call_raw_pending",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls -la" });

    const output = view.render(120).join("\n");
    expect(output).not.toContain("Executing");
    expect(output).not.toMatch(BRAILLE_SPINNER_GLYPHS);
  });

  // Regression: raw fallback used to carry a trailing blank line from
  // Markdown's `space` token, making the next container start with a gap.
  it("raw fallback path has no trailing blank line", () => {
    const view = new BaseToolCallView(
      "call_raw_noblank",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls" });

    const lines = view.render(120);
    const lastLine = lines.at(-1) ?? "";
    expect(lastLine.trim().length).toBeGreaterThan(0);
  });
});
