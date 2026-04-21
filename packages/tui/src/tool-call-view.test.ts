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
});
