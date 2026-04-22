import { Container, Spacer, Text } from "@mariozechner/pi-tui";
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

const SEPARATOR_BLANK = 1;

const mountInlineSpinner = (chat: Container, label: string): (() => void) => {
  const spacer = new Spacer(1);
  const spinner = new Text(` ${stylePendingIndicator("⠋", label)} `, 0, 0);
  chat.addChild(spacer);
  chat.addChild(spinner);
  return () => {
    chat.removeChild(spacer);
    chat.removeChild(spinner);
  };
};

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

describe("Inline spinner layout inside chatContainer", () => {
  // The spinner now mounts INSIDE chatContainer as the last child (after a
  // Spacer(1) separator). This keeps the status slot inline with chat so
  // clearing the spinner lets subsequent chat content take its place without
  // any upward layout shift.
  it("pretty-block pending: exactly 1 blank line between tool block and spinner", () => {
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
    mountInlineSpinner(chat, "Executing...");

    const lines = chat.render(80);
    const blanksAboveSpinner = countLeadingBlanksBefore(lines, (line) =>
      line.includes("Executing")
    );
    expect(blanksAboveSpinner).toBe(SEPARATOR_BLANK);

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
    mountInlineSpinner(chat, "Working...");

    const lines = chat.render(80);
    const blanksAboveSpinner = countLeadingBlanksBefore(lines, (line) =>
      line.includes("Working")
    );
    expect(blanksAboveSpinner).toBe(SEPARATOR_BLANK);

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
    mountInlineSpinner(chat, "Executing...");

    const lines = chat.render(120);
    const blanksAboveSpinner = countLeadingBlanksBefore(lines, (line) =>
      line.includes("Executing")
    );
    expect(blanksAboveSpinner).toBe(SEPARATOR_BLANK);

    view.dispose();
  });
});

describe("Inline spinner detach leaves no residual children", () => {
  // Mounting and unmounting the spinner repeatedly must not leak the
  // separator Spacer or the spinner itself into chatContainer. If it did,
  // each tool cycle would accumulate blank lines above subsequent content.
  it("mount/unmount cycles leave chat with only its original children", () => {
    const view = new BaseToolCallView(
      "call_cycle",
      "shell_execute",
      markdownTheme,
      () => undefined
    );
    view.setFinalInput({ command: "ls" });

    const chat = new Container();
    chat.addChild(view);
    const childrenBefore = chat.render(80).length;

    for (let i = 0; i < 3; i++) {
      const detach = mountInlineSpinner(chat, "Working...");
      detach();
    }

    const childrenAfter = chat.render(80).length;
    expect(childrenAfter).toBe(childrenBefore);

    view.dispose();
  });
});

describe("Chat container trailing shape (so the spinner only adds its own blank)", () => {
  // Regression: BaseToolCallView.render() must NEVER emit a trailing blank
  // line. A trailing blank would combine with the inline separator Spacer(1)
  // and show as 2+ blank lines above the spinner.
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
