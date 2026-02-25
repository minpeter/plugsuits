import { describe, expect, it } from "bun:test";
import {
  type InteractResult,
  parseKeys,
  shellInteractTool,
} from "./shell-interact";

async function interact(
  keystrokes: string,
  timeout_ms = 200
): Promise<InteractResult> {
  const execute = shellInteractTool.execute;
  if (!execute) {
    throw new Error("shellInteractTool.execute is undefined");
  }

  const result = await execute(
    { keystrokes, timeout_ms },
    {
      toolCallId: `test-${Date.now()}`,
      messages: [],
      abortSignal: new AbortController().signal,
    }
  );

  if (Symbol.asyncIterator in (result as object)) {
    throw new Error("Unexpected async iterable result");
  }

  return result as InteractResult;
}

describe("shellInteractTool", () => {
  describe("result shape", () => {
    it("returns { success: true, output: string }", async () => {
      const result = await interact("echo test");

      expect(result.success).toBe(true);
      expect(typeof result.output).toBe("string");
      expect(result.output.length).toBeGreaterThan(0);
    });

    it("always succeeds regardless of keystrokes", async () => {
      const result = await interact("anything at all");

      expect(result.success).toBe(true);
    });
  });

  describe("Ctrl+C guidance", () => {
    it("returns Ctrl+C guidance for <Ctrl+C>", async () => {
      const result = await interact("<Ctrl+C>");

      expect(result.success).toBe(true);
      expect(result.output).toContain("No retained terminal context exists");
      expect(result.output).toContain("kill -SIGINT");
    });

    it("returns Ctrl+C guidance for <CTRL+C> (uppercase)", async () => {
      const result = await interact("<CTRL+C>");

      expect(result.success).toBe(true);
      expect(result.output).toContain("kill -SIGINT");
    });

    it("returns Ctrl+C guidance for <C-c> (dash syntax)", async () => {
      const result = await interact("<C-c>");

      expect(result.success).toBe(true);
      expect(result.output).toContain("kill -SIGINT");
    });

    it("returns Ctrl+C guidance for html-encoded &lt;Ctrl+C&gt;", async () => {
      const result = await interact("&lt;Ctrl+C&gt;");

      expect(result.success).toBe(true);
      expect(result.output).toContain("kill -SIGINT");
    });

    it("Ctrl+C guidance mentions timeout", async () => {
      const result = await interact("<Ctrl+C>");

      expect(result.output).toContain("120s");
    });
  });

  describe("generic guidance for other keystrokes", () => {
    it("returns generic guidance for plain text", async () => {
      const result = await interact("ls -la");

      expect(result.success).toBe(true);
      expect(result.output).toContain("No retained terminal context exists");
      expect(result.output).toContain("shell_execute");
      expect(result.output).not.toContain("kill -SIGINT");
    });

    it("returns generic guidance for Enter key", async () => {
      const result = await interact("echo hello<Enter>");

      expect(result.success).toBe(true);
      expect(result.output).toContain("shell_execute");
      expect(result.output).not.toContain("kill -SIGINT");
    });

    it("returns generic guidance for Ctrl+D", async () => {
      const result = await interact("<Ctrl+D>");

      expect(result.success).toBe(true);
      expect(result.output).not.toContain("kill -SIGINT");
    });

    it("returns generic guidance for empty keystrokes", async () => {
      const result = await interact("");

      expect(result.success).toBe(true);
      expect(result.output).toContain("shell_execute");
    });

    it("explains no retained terminal context exists", async () => {
      const result = await interact("any command");

      expect(result.output).toContain(
        "No retained terminal context exists. Each shell_execute command runs independently."
      );
    });
  });

  describe("tool metadata", () => {
    it("has description mentioning shell_execute", () => {
      expect(shellInteractTool.description).toContain("shell_execute");
    });

    it("accepts keystrokes in inputSchema", () => {
      expect(shellInteractTool.inputSchema).toBeDefined();
    });
  });

  describe("parseKeys utility", () => {
    it("parses plain text as individual characters", () => {
      const result = parseKeys("abc");
      expect(result).toEqual(["a", "b", "c"]);
    });

    it("parses <Enter> to Enter", () => {
      const result = parseKeys("<Enter>");
      expect(result).toEqual(["Enter"]);
    });

    it("parses <Ctrl+C> to C-c", () => {
      const result = parseKeys("<Ctrl+C>");
      expect(result).toEqual(["C-c"]);
    });

    it("parses <Tab> to Tab", () => {
      const result = parseKeys("<Tab>");
      expect(result).toEqual(["Tab"]);
    });

    it("parses <Escape> and <ESC>", () => {
      expect(parseKeys("<Escape>")).toEqual(["Escape"]);
      expect(parseKeys("<ESC>")).toEqual(["Escape"]);
    });

    it("parses <Up> <Down> <Left> <Right>", () => {
      expect(parseKeys("<Up>")).toEqual(["Up"]);
      expect(parseKeys("<Down>")).toEqual(["Down"]);
      expect(parseKeys("<Left>")).toEqual(["Left"]);
      expect(parseKeys("<Right>")).toEqual(["Right"]);
    });

    it("parses <Home> and <End>", () => {
      expect(parseKeys("<Home>")).toEqual(["Home"]);
      expect(parseKeys("<End>")).toEqual(["End"]);
    });

    it("parses <Backspace> and <Delete>", () => {
      expect(parseKeys("<Backspace>")).toEqual(["BSpace"]);
      expect(parseKeys("<Delete>")).toEqual(["DC"]);
    });

    it("parses <Space>", () => {
      expect(parseKeys("<Space>")).toEqual(["Space"]);
    });

    it("parses mixed text and special keys", () => {
      const result = parseKeys("echo<Space>hello<Enter>");
      expect(result).toEqual([
        "e",
        "c",
        "h",
        "o",
        "Space",
        "h",
        "e",
        "l",
        "l",
        "o",
        "Enter",
      ]);
    });

    it("parses <C-c> dash syntax to C-c", () => {
      const result = parseKeys("<C-c>");
      expect(result).toEqual(["C-c"]);
    });

    it("parses <ctrl-c> dash syntax to C-c", () => {
      const result = parseKeys("<ctrl-c>");
      expect(result).toEqual(["C-c"]);
    });

    it("handles html-encoded &lt;Ctrl+C&gt;", () => {
      const result = parseKeys("&lt;Ctrl+C&gt;");
      expect(result).toEqual(["C-c"]);
    });

    it("preserves HTML entities in plain text (non-special)", () => {
      const parsed = parseKeys(
        "echo '&lt;entity-preserve-tag&gt; &amp; preserve-amp'"
      );
      expect(parsed.join("")).toBe(
        "echo '&lt;entity-preserve-tag&gt; &amp; preserve-amp'"
      );
    });

    it("treats unknown <token> as literal characters", () => {
      const result = parseKeys("<unknown>");
      expect(result.join("")).toBe("<unknown>");
    });

    it("parses <PageUp> and <PageDown>", () => {
      expect(parseKeys("<PageUp>")).toEqual(["PPage"]);
      expect(parseKeys("<PageDown>")).toEqual(["NPage"]);
    });
  });
});
