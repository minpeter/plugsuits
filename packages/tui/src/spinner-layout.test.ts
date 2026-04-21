import { Container } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { stylePendingIndicator } from "./pending-spinner";
import { BaseToolCallView } from "./tool-call-view";

const markdownTheme = {
  heading: (t: string) => t,
  link: (t: string) => t,
  linkUrl: (t: string) => t,
  code: (t: string) => t,
  codeBlock: (t: string) => t,
  codeBlockBorder: (t: string) => t,
  quote: (t: string) => t,
  quoteBorder: (t: string) => t,
  hr: (t: string) => t,
  listBullet: (t: string) => t,
  bold: (t: string) => t,
  italic: (t: string) => t,
  strikethrough: (t: string) => t,
  underline: (t: string) => t,
};

const SPINNER_PREPENDED_BLANK = 1;

const renderSpinnerLayout = (label: string, width: number): string[] => [
  "",
  ` ${stylePendingIndicator("⠋", label)} `.padEnd(width, " "),
];

const countTrailingBlanks = (lines: string[]): number => {
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length === 0) {
      n++;
    } else {
      break;
    }
  }
  return n;
};

const countLeadingBlanksBefore = (
  lines: string[],
  predicate: (line: string) => boolean
): number => {
  const idx = lines.findIndex(predicate);
  if (idx <= 0) {
    return 0;
  }
  let n = 0;
  for (let i = idx - 1; i >= 0; i--) {
    if (lines[i].trim().length === 0) {
      n++;
    } else {
      break;
    }
  }
  return n;
};

describe("Screen layout: blank line count between tool block and foreground spinner", () => {
  // Regression: user reported "공백 2개" between tool block and Executing...
  // The foreground spinner prepends exactly 1 blank line via
  // StatusSpinner.render() → ["", ...super.render(width)]. Any additional
  // blank coming from chatContainer's last child pushes the spinner down.
  it("pretty-block pending: exactly 1 blank line above the spinner", () => {
    const view = new BaseToolCallView(
      "call_layout_pending",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls" });
    view.setPrettyBlock("**Shell** `ls`", "", {
      isPending: true,
      useBackground: false,
    });

    const chat = new Container();
    chat.addChild(view);

    const chatLines = chat.render(80);
    const spinnerLines = renderSpinnerLayout("Executing...", 80);
    const combined = [...chatLines, ...spinnerLines];

    const blanksAboveSpinner = countLeadingBlanksBefore(combined, (line) =>
      line.includes("Executing")
    );
    expect(blanksAboveSpinner).toBe(SPINNER_PREPENDED_BLANK);

    view.dispose();
  });

  it("pretty-block non-pending (with output): exactly 1 blank above the spinner", () => {
    const view = new BaseToolCallView(
      "call_layout_result",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls" });
    view.setOutput("a\nb");
    view.setPrettyBlock("**Shell** `ls`", "a\nb", { useBackground: false });

    const chat = new Container();
    chat.addChild(view);

    const chatLines = chat.render(80);
    const spinnerLines = renderSpinnerLayout("Working...", 80);
    const combined = [...chatLines, ...spinnerLines];

    const blanksAboveSpinner = countLeadingBlanksBefore(combined, (line) =>
      line.includes("Working")
    );
    expect(blanksAboveSpinner).toBe(SPINNER_PREPENDED_BLANK);

    view.dispose();
  });

  it("raw fallback tool block: exactly 1 blank above the spinner", () => {
    const view = new BaseToolCallView(
      "call_layout_raw",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls" });

    const chat = new Container();
    chat.addChild(view);

    const chatLines = chat.render(120);
    const spinnerLines = renderSpinnerLayout("Executing...", 120);
    const combined = [...chatLines, ...spinnerLines];

    const blanksAboveSpinner = countLeadingBlanksBefore(combined, (line) =>
      line.includes("Executing")
    );
    expect(blanksAboveSpinner).toBe(SPINNER_PREPENDED_BLANK);

    view.dispose();
  });
});

describe("Chat container trailing shape (so the spinner only adds its own blank)", () => {
  // Regression: BaseToolCallView.render() must NEVER emit a trailing blank
  // line. Any trailing blank would combine with StatusSpinner's own leading
  // blank and show as 2+ blank lines above the spinner.
  it.each([
    {
      name: "raw fallback with input only",
      build: (view: BaseToolCallView) => {
        view.setFinalInput({ command: "ls" });
      },
    },
    {
      name: "raw fallback with input and output",
      build: (view: BaseToolCallView) => {
        view.setFinalInput({ command: "ls" });
        view.setOutput("a\nb");
      },
    },
    {
      name: "pretty-block pending (empty body)",
      build: (view: BaseToolCallView) => {
        view.setFinalInput({ command: "ls" });
        view.setPrettyBlock("**Shell** `ls`", "", {
          isPending: true,
          useBackground: false,
        });
      },
    },
    {
      name: "pretty-block non-pending (with body)",
      build: (view: BaseToolCallView) => {
        view.setFinalInput({ command: "ls" });
        view.setOutput("a\nb");
        view.setPrettyBlock("**Shell** `ls`", "a\nb", {
          useBackground: false,
        });
      },
    },
  ])("$name leaves no trailing blank", ({ build }) => {
    const view = new BaseToolCallView(
      "call",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    build(view);

    const lines = view.render(120);
    expect(countTrailingBlanks(lines)).toBe(0);

    view.dispose();
  });
});
