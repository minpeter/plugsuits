import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { cleanupSession, getSharedSession } from "./shared-tmux-session";

const SESSION_ID_PATTERN = /^cea-\d+-[a-z0-9]+$/;
const TERMINAL_OUTPUT_PATTERN = /Terminal (Screen|Output)/;

describe("SharedTmuxSession", () => {
  beforeAll(() => {
    cleanupSession();
  });

  afterEach(() => {
    cleanupSession();
  });

  afterAll(() => {
    cleanupSession();
  });

  describe("singleton pattern", () => {
    it("returns the same instance on multiple calls", () => {
      const session1 = getSharedSession();
      const session2 = getSharedSession();

      expect(session1).toBe(session2);
    });

    it("returns consistent session ID", () => {
      const session = getSharedSession();
      const id1 = session.getSessionId();
      const id2 = session.getSessionId();

      expect(id1).toBe(id2);
      expect(id1).toMatch(SESSION_ID_PATTERN);
    });
  });

  describe("session lifecycle", () => {
    it("creates session on first command", async () => {
      const session = getSharedSession();
      await session.executeCommand("echo test");

      expect(session.isSessionAlive()).toBe(true);
    });

    it("session survives multiple commands", async () => {
      const session = getSharedSession();
      await session.executeCommand("echo first");
      await session.executeCommand("echo second");

      expect(session.isSessionAlive()).toBe(true);
    });
  });

  describe("executeCommand", () => {
    it("executes simple command and returns output", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand("echo hello");

      expect(result.output).toBe("hello");
      expect(result.exitCode).toBe(0);
    });

    it("returns correct exit code for failed command", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand("(exit 5)");

      expect(result.exitCode).toBe(5);
    });

    it("executes command in specified workdir", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand("pwd", { workdir: "/tmp" });

      expect(result.output).toBe("/tmp");
    });

    it("handles command with special characters", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand("echo \"hello 'world'\"");

      expect(result.output).toBe("hello 'world'");
    });

    it("handles multiline output", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand(
        "printf 'line1\\nline2\\nline3'"
      );

      expect(result.output).toBe("line1\nline2\nline3");
    });

    it("handles heredoc commands without hanging", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand(
        "cat <<'EOF'\nalpha\nbeta\nEOF",
        {
          timeoutMs: 5000,
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("alpha\nbeta");
    });

    it("handles empty output", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand("true");

      expect(result.output).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("handles pipes correctly", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand('echo "a b c" | wc -w');

      expect(result.output.trim()).toBe("3");
    });

    it("handles environment variables", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand("echo $HOME");

      expect(result.output).toBe(process.env.HOME ?? "");
    });
  });

  describe("background process detection", () => {
    it("detects command ending with &", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand("sleep 0.1 &");

      expect(result.output).toContain("[Background process started]");
      expect(result.exitCode).toBe(0);
    });

    it("does not treat && as background operator", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand("echo a && echo b");

      expect(result.output).toBe("a\nb");
      expect(result.output).not.toContain("[Background process started]");
    });

    it("handles & with preceding space", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand("sleep 0.1 &  ");

      expect(result.output).toContain("[Background process started]");
    });
  });

  describe("timeout handling", () => {
    it("returns error for long-running command", async () => {
      const session = getSharedSession();
      const result = await session.executeCommand("sleep 10", {
        timeoutMs: 100,
      });

      expect([1, 124]).toContain(result.exitCode);
      const hasRelevantMessage =
        result.output.includes("timed out") ||
        result.output.includes("interactive") ||
        result.output.includes("foreground process");
      expect(hasRelevantMessage).toBe(true);
    });
  });

  describe("sendKeys", () => {
    it("sends keys without blocking", async () => {
      const session = getSharedSession();
      const output = await session.sendKeys(["echo test"], {
        block: false,
        minTimeoutMs: 100,
      });

      expect(typeof output).toBe("string");
    });

    it("handles array of keys", async () => {
      const session = getSharedSession();
      await session.executeCommand("true");
      await session.sendKeys(["e", "c", "h", "o", " ", "h", "i"], {
        block: false,
        minTimeoutMs: 100,
      });

      const pane = session.capturePane();
      expect(pane).toContain("echo hi");
    });
  });

  describe("capturePane", () => {
    it("captures visible pane content", async () => {
      const session = getSharedSession();
      await session.executeCommand("echo visible-content");

      const pane = session.capturePane(false);
      expect(pane).toContain("visible-content");
    });

    it("captures entire history when flag is true", async () => {
      const session = getSharedSession();
      await session.executeCommand("echo history-content");

      const pane = session.capturePane(true);
      expect(pane).toContain("history-content");
    });
  });

  describe("getIncrementalOutput", () => {
    it("returns output containing terminal content", async () => {
      const session = getSharedSession();
      await session.executeCommand("echo incremental-test");

      const output = session.getIncrementalOutput();
      expect(output.length).toBeGreaterThan(0);
      expect(output).toMatch(TERMINAL_OUTPUT_PATTERN);
    });

    it("returns new content on subsequent calls", async () => {
      const session = getSharedSession();

      session.getIncrementalOutput();
      await session.executeCommand("echo new-content-here");

      const output = session.getIncrementalOutput();
      expect(output.length).toBeGreaterThan(0);
    });
  });

  describe("clearHistory", () => {
    it("clears terminal history", async () => {
      const session = getSharedSession();
      await session.executeCommand("echo before-clear");

      session.clearHistory();

      const result = await session.executeCommand("echo after-clear");
      expect(result.output).toBe("after-clear");
    });
  });

  describe("cleanup and reset", () => {
    it("kills session on cleanup", async () => {
      const session = getSharedSession();
      await session.executeCommand("echo test");
      const wasAlive = session.isSessionAlive();

      cleanupSession();

      const newSession = getSharedSession();
      expect(newSession.getSessionId()).not.toBe(session.getSessionId());
      expect(wasAlive).toBe(true);
    });

    it("handles cleanup when not initialized", () => {
      cleanupSession();
      cleanupSession();
    });
  });

  describe("parallel execution isolation", () => {
    it("handles concurrent commands without mixing output", async () => {
      const session = getSharedSession();

      const [result1, result2, result3] = await Promise.all([
        session.executeCommand("echo parallel-1"),
        session.executeCommand("echo parallel-2"),
        session.executeCommand("echo parallel-3"),
      ]);

      expect(result1.exitCode).toBe(0);
      expect(result2.exitCode).toBe(0);
      expect(result3.exitCode).toBe(0);

      const outputs = [result1.output, result2.output, result3.output];
      for (const output of outputs) {
        expect(output).not.toContain("__CEA_S_");
        expect(output).not.toContain("__CEA_E_");
      }
    });
  });
});
