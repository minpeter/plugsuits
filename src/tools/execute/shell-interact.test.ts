import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cleanupSession, getSharedSession } from "./shared-tmux-session";
import { type InteractResult, shellInteractTool } from "./shell-interact";

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

  // Handle both direct result and async iterable
  if (Symbol.asyncIterator in (result as object)) {
    throw new Error("Unexpected async iterable result");
  }

  return result as InteractResult;
}

describe("shellInteractTool", () => {
  beforeAll(async () => {
    cleanupSession();
    // Initialize session with a simple command
    const session = getSharedSession();
    await session.executeCommand("echo initialized");
  });

  afterAll(() => {
    cleanupSession();
  });

  describe("basic key sending", () => {
    it("sends simple text", async () => {
      const result = await interact("echo test");

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });

    it("does not leak internal markers", async () => {
      const session = getSharedSession();
      await session.executeCommand("echo marker-leak-test");

      const result = await interact("", 100);

      expect(result.success).toBe(true);
      expect(result.output).not.toContain("__CEA_S_");
      expect(result.output).not.toContain("__CEA_E_");
      expect(result.output).not.toContain("tmux wait -S cea-");
    });

    it("sends text with Enter key", async () => {
      const result = await interact("echo hello<Enter>", 500);

      expect(result.success).toBe(true);
      expect(result.output).toContain("hello");
    });

    it("returns output even when empty", async () => {
      const result = await interact("", 100);

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });
  });

  describe("special keys parsing", () => {
    it("handles Enter key", async () => {
      // Clear any pending input first
      await interact("<Ctrl+C>");

      const result = await interact("echo enter-test<Enter>", 500);

      expect(result.success).toBe(true);
      expect(result.output).toContain("enter-test");
    });

    it("handles Tab key for completion", async () => {
      const result = await interact("ech<Tab>", 300);

      expect(result.success).toBe(true);
    });

    it("handles Ctrl+C to interrupt", async () => {
      // Start a sleep command
      await interact("sleep 100<Enter>");

      // Send Ctrl+C to interrupt
      const result = await interact("<Ctrl+C>", 500);

      expect(result.success).toBe(true);
    });

    it("handles Ctrl+D", async () => {
      const result = await interact("<Ctrl+D>");

      expect(result.success).toBe(true);
    });

    it("handles Escape key", async () => {
      const result = await interact("<Escape>", 100);

      expect(result.success).toBe(true);
    });

    it("handles arrow keys", async () => {
      const result = await interact("<Up><Down><Left><Right>");

      expect(result.success).toBe(true);
    });

    it("handles Home and End keys", async () => {
      const result = await interact("test<Home><End>");

      expect(result.success).toBe(true);
    });

    it("handles Backspace and Delete", async () => {
      const result = await interact("abc<Backspace><Delete>");

      expect(result.success).toBe(true);
    });

    it("handles PageUp and PageDown", async () => {
      const result = await interact("<PageUp><PageDown>");

      expect(result.success).toBe(true);
    });

    it("handles Space key", async () => {
      const result = await interact("echo<Space>space-test<Enter>", 500);

      expect(result.success).toBe(true);
      expect(result.output).toContain("space-test");
    });
  });

  describe("case insensitive special keys", () => {
    it("handles lowercase enter", async () => {
      const result = await interact("echo lower<enter>", 500);

      expect(result.success).toBe(true);
      expect(result.output).toContain("lower");
    });

    it("handles uppercase CTRL+C", async () => {
      const result = await interact("<CTRL+C>");

      expect(result.success).toBe(true);
    });

    it("handles mixed case Escape/ESC", async () => {
      const result = await interact("<ESC><esc><Esc>");

      expect(result.success).toBe(true);
    });
  });

  describe("Ctrl key combinations", () => {
    it("handles Ctrl+L to clear screen", async () => {
      const result = await interact("<Ctrl+L>");

      expect(result.success).toBe(true);
    });

    it("handles Ctrl+A to go to beginning of line", async () => {
      const result = await interact("test<Ctrl+A>");

      expect(result.success).toBe(true);
    });

    it("handles Ctrl+E to go to end of line", async () => {
      const result = await interact("test<Ctrl+A><Ctrl+E>");

      expect(result.success).toBe(true);
    });

    it("handles Ctrl+K to kill to end of line", async () => {
      const result = await interact("test<Ctrl+A><Ctrl+K>");

      expect(result.success).toBe(true);
    });

    it("handles Ctrl+U to kill to beginning of line", async () => {
      const result = await interact("test<Ctrl+U>");

      expect(result.success).toBe(true);
    });

    it("handles Ctrl+W to delete word", async () => {
      const result = await interact("hello world<Ctrl+W>");

      expect(result.success).toBe(true);
    });

    it("handles Ctrl+Z to suspend", async () => {
      // Start a simple command that we can suspend
      await interact("cat<Enter>");

      const result = await interact("<Ctrl+Z>", 500);

      expect(result.success).toBe(true);

      // Clean up suspended job
      await interact("kill %1 2>/dev/null || true<Enter>", 300);
    });

    it("handles Ctrl+R for reverse search", async () => {
      const result = await interact("<Ctrl+R>");

      expect(result.success).toBe(true);

      // Exit search mode
      await interact("<Ctrl+C>");
    });
  });

  describe("timeout_ms parameter", () => {
    it("uses default timeout_ms when not specified", async () => {
      const execute = shellInteractTool.execute;
      if (!execute) {
        throw new Error("shellInteractTool.execute is undefined");
      }

      const start = Date.now();
      await execute(
        { keystrokes: "test" },
        {
          toolCallId: "duration-test",
          messages: [],
          abortSignal: new AbortController().signal,
        }
      );
      const elapsed = Date.now() - start;

      // Default is 500ms
      expect(elapsed).toBeGreaterThanOrEqual(400);
    });

    it("respects custom timeout_ms", async () => {
      const start = Date.now();
      await interact("test", 100);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("interactive program scenarios", () => {
    it("responds to yes/no prompt", async () => {
      const result = await interact("y<Enter>");

      expect(result.success).toBe(true);
    });

    it("sends password-like input", async () => {
      const result = await interact("secretpass123!@#<Enter>");

      expect(result.success).toBe(true);
    });

    it("handles multi-step interaction", async () => {
      // First interaction
      const result1 = await interact("export TEST_VAR=hello<Enter>", 300);
      expect(result1.success).toBe(true);

      // Second interaction using the variable
      const result2 = await interact('echo "Value: $TEST_VAR"<Enter>', 500);
      expect(result2.success).toBe(true);
      expect(result2.output).toContain("hello");
    });
  });

  describe("mixed text and special keys", () => {
    it("handles text with multiple special keys", async () => {
      const result = await interact("ls<Space>-la<Enter>", 500);

      expect(result.success).toBe(true);
    });

    it("handles navigation during typing", async () => {
      const result = await interact("hello<Left><Left>XX<End>YY");

      expect(result.success).toBe(true);
    });
  });

  describe("tool metadata", () => {
    it("has correct tool name in description", () => {
      expect(shellInteractTool.description).toContain("shell_execute");
    });
  });
});
