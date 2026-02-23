import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand } from "./shell-execute";

describe("executeCommand", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "shell-test-"));
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  describe("basic execution", () => {
    it("executes simple echo command", async () => {
      const result = await executeCommand('echo "hello world"');

      expect(result.output).toContain("hello world");
      expect(result.exitCode).toBe(0);
    });

    it("captures multiline output", async () => {
      const result = await executeCommand("printf 'line1\\nline2\\nline3'");

      expect(result.output).toContain("line1");
      expect(result.output).toContain("line2");
      expect(result.output).toContain("line3");
    });

    it("combines stdout and stderr", async () => {
      const result = await executeCommand('echo "stdout" && echo "stderr" >&2');

      expect(result.output).toContain("stdout");
      expect(result.output).toContain("stderr");
    });

    it("handles empty output", async () => {
      const result = await executeCommand("true");

      expect(result.output).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("executes command in specified workdir", async () => {
      const result = await executeCommand("pwd", { workdir: tempDir });

      expect(result.output).toContain("shell-test-");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("exit code propagation", () => {
    it("returns non-zero exit code for failed command", async () => {
      const result = await executeCommand("exit 42");

      expect(result.exitCode).toBe(42);
    });

    it("returns zero for successful command", async () => {
      const result = await executeCommand("echo ok");

      expect(result.exitCode).toBe(0);
    });

    it("returns exit code from last command in chain", async () => {
      const result = await executeCommand("true && exit 5");

      expect(result.exitCode).toBe(5);
    });
  });

  describe("timeout formatting", () => {
    it("includes [TIMEOUT] prefix when command exceeds timeout", async () => {
      const result = await executeCommand("sleep 10", { timeoutMs: 200 });

      expect(result.output).toContain("[TIMEOUT]");
      expect(result.exitCode).toBe(124);
    }, 5000);

    it("includes timeout duration in timeout message", async () => {
      const result = await executeCommand("sleep 10", { timeoutMs: 300 });

      expect(result.output).toContain("300ms");
    }, 5000);
  });

  describe("background process detection", () => {
    it("wraps output with background message for commands ending with &", async () => {
      const result = await executeCommand("sleep 0.1 &");

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("[Background process started]");
    });

    it("does not treat && as background operator", async () => {
      const result = await executeCommand('echo "first" && echo "second"');

      expect(result.output).toContain("first");
      expect(result.output).not.toContain("[Background process started]");
    });

    it("does not treat mid-command & as background", async () => {
      const result = await executeCommand("sleep 0.1 & wait");

      expect(result.output).not.toContain("[Background process started]");
    });
  });
});
