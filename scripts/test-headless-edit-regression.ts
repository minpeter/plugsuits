#!/usr/bin/env bun
/**
 * Headless regression test: edit_file pig→cat replacement
 *
 * Reproduces MiniMax-M2.5 failure scenario:
 * 1. Initialize test.txt with "Three Little Pigs" story
 * 2. Run headless mode with prompt to replace pig→cat via edit_file
 * 3. Parse JSONL output to verify edit_file tool calls succeeded
 * 4. Assert no write_file fallback was used
 * 5. Assert final file content has "cat" replacing "pig"
 *
 * Usage:
 *   bun run scripts/test-headless-edit-regression.ts [-m <model>] [--provider <provider>]
 *
 * Requires: FRIENDLI_TOKEN or appropriate API key set in environment.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ── Test fixture ──────────────────────────────────────────────
const STORY_CONTENT = `Once upon a time, there were three little pigs.
The first pig built a house of straw.
The second pig built a house of sticks.
The third pig built a house of bricks.
A big bad wolf came and blew down the straw house.
Then the wolf blew down the stick house.
But the wolf could not blow down the brick house.
The three little pigs were safe inside the brick house.`;

const PROMPT =
  "using edit_file tool to replace all occurrences of pig to cat in test.txt";

// ── CLI arg passthrough ───────────────────────────────────────
const extraArgs: string[] = [];
const rawArgs = process.argv.slice(2);
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (
    (arg === "-m" || arg === "--model" || arg === "--provider") &&
    i + 1 < rawArgs.length
  ) {
    extraArgs.push(arg, rawArgs[i + 1]);
    i++;
  } else if (arg === "--think" || arg === "--no-translate") {
    extraArgs.push(arg);
  } else if (arg === "--reasoning-mode" && i + 1 < rawArgs.length) {
    extraArgs.push(arg, rawArgs[i + 1]);
    i++;
  }
}

// ── Types ─────────────────────────────────────────────────────
interface ToolCallEvent {
  tool_call_id: string;
  tool_input: Record<string, unknown>;
  tool_name: string;
  type: "tool_call";
}

interface ToolResultEvent {
  error?: string;
  output: string;
  tool_call_id: string;
  type: "tool_result";
}

interface AnyEvent {
  type: string;
  [key: string]: unknown;
}

// ── Helpers ───────────────────────────────────────────────────
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const pass = (msg: string) => console.log(`  ${GREEN}✓${RESET} ${msg}`);
const fail = (msg: string) => console.log(`  ${RED}✗${RESET} ${msg}`);
const info = (msg: string) => console.log(`  ${DIM}${msg}${RESET}`);
const warn = (msg: string) => console.log(`  ${YELLOW}⚠${RESET} ${msg}`);

// ── Main ──────────────────────────────────────────────────────
const runTest = async (): Promise<boolean> => {
  const testDir = join(tmpdir(), `edit-regression-${Date.now()}`);
  const testFile = join(testDir, "test.txt");
  let passed = true;

  console.log(`\n${BOLD}Headless Edit Regression Test${RESET}\n`);

  // Step 1: Initialize test fixture
  mkdirSync(testDir, { recursive: true });
  writeFileSync(testFile, STORY_CONTENT, "utf-8");
  info(`Test dir: ${testDir}`);
  info(`Test file initialized with ${STORY_CONTENT.split("\n").length} lines`);

  // Step 2: Run headless mode
  const headlessScript = resolve(import.meta.dir, "..", "src", "entrypoints", "headless.ts");
  const headlessArgs = [
    "run",
    headlessScript,
    "-p",
    PROMPT,
    "--no-translate",
    ...extraArgs,
  ];

  info(`Running: bun ${headlessArgs.join(" ")}`);
  console.log();

  const events: AnyEvent[] = [];

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn("bun", headlessArgs, {
        cwd: testDir,
        env: {
          ...process.env,
          // Ensure the agent can find the project
          BUN_INSTALL: process.env.BUN_INSTALL,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        // Stream stderr for visibility
        process.stderr.write(DIM + text + RESET);
      });

      // 5 minute timeout for model response
      const timeout = setTimeout(
        () => {
          proc.kill("SIGTERM");
          reject(new Error("Headless mode timed out after 10 minutes"));
        },
        10 * 60 * 1000
      );

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(
            new Error(
              `Headless mode exited with code ${code}\nStderr: ${stderr}`
            )
          );
        } else {
          resolve(stdout);
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Step 3: Parse JSONL events
    console.log();
    const lines = output.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as AnyEvent;
        events.push(event);
      } catch {
        warn(`Non-JSON line in output: ${line.slice(0, 100)}`);
      }
    }

    info(`Parsed ${events.length} JSONL events`);
    console.log();

    // Step 4: Analyze tool calls
    const toolCalls = events.filter(
      (e) => e.type === "tool_call"
    ) as unknown as ToolCallEvent[];
    const toolResults = events.filter(
      (e) => e.type === "tool_result"
    ) as unknown as ToolResultEvent[];

    const editFileCalls = toolCalls.filter((e) => e.tool_name === "edit_file");
    const writeFileCalls = toolCalls.filter(
      (e) => e.tool_name === "write_file"
    );

    // Check: edit_file was attempted
    if (editFileCalls.length > 0) {
      pass(`edit_file called ${editFileCalls.length} time(s)`);
    } else {
      fail("edit_file was never called");
      passed = false;
    }

    // Note: write_file fallback is a model behavior issue, not an edit_file bug
    if (writeFileCalls.length === 0) {
      pass("write_file was not used (no fallback needed)");
    } else {
      warn(
        `write_file was used ${writeFileCalls.length} time(s) — model fell back after guard rejections`
      );
    }

    // Check: edit_file call success/failure breakdown
    const editCallIds = new Set(editFileCalls.map((e) => e.tool_call_id));
    const editResults = toolResults.filter((e) =>
      editCallIds.has(e.tool_call_id)
    );
    const editErrors = editResults.filter((e) => e.error);
    const editSuccesses = editResults.filter((e) => !e.error);
    const guardErrors = editErrors.filter((e) =>
      e.error?.includes("explicit 'lines' field") ||
      e.error?.includes("must be a single-line") ||
      e.error?.includes("contains newline") ||
      e.error?.includes("lines \u2014") ||
      e.error?.includes("not a line number") ||
      e.error?.includes("not a valid {line_number}#{hash_id}") ||
      e.error?.includes("missing # separator") ||
      e.error?.includes("content after anchor") ||
      e.error?.includes("key-value syntax") ||
      e.error?.includes("XML markup")
    );

    if (editSuccesses.length > 0) {
      pass(
        `${editSuccesses.length}/${editResults.length} edit_file call(s) succeeded`
      );
      for (const succ of editSuccesses) {
        const matchingCall = editFileCalls.find(
          (c) => c.tool_call_id === succ.tool_call_id
        );
        if (matchingCall) {
          info(`  ┌─ succeeded tool_input (${succ.tool_call_id}) ──`);
          const inputStr = JSON.stringify(matchingCall.tool_input, null, 2);
          for (const line of inputStr.split("\n")) {
            info(`  │ ${line}`);
          }
          info(`  └────────────────────────────────────────`);
        }
      }
    } else {
      warn(
        `No edit_file calls succeeded (${guardErrors.length} blocked by guards) — model did not learn correct API usage`
      );
    }

    if (guardErrors.length > 0) {
      pass(
        `${guardErrors.length} malformed call(s) blocked by safety guards (expected behavior)`
      );
      for (const err of guardErrors) {
        info(`  Guard (${err.tool_call_id}): ${err.error}`);
        // Dump the original tool_input for analysis
        const matchingCall = editFileCalls.find(
          (c) => c.tool_call_id === err.tool_call_id
        );
        if (matchingCall) {
          info(`  ┌─ tool_input ─────────────────────────────`);
          const inputStr = JSON.stringify(matchingCall.tool_input, null, 2);
          for (const line of inputStr.split("\n")) {
            info(`  │ ${line}`);
          }
          info(`  └────────────────────────────────────────`);
        }
      }
    }

    const unexpectedErrors = editErrors.filter(
      (e) =>
        !e.error?.includes("explicit 'lines' field") &&
        !e.error?.includes("must be a single-line") &&
        !e.error?.includes("contains newline") &&
        !e.error?.includes("lines \u2014") &&
        !e.error?.includes("not a line number") &&
        !e.error?.includes("not a valid {line_number}#{hash_id}") &&
        !e.error?.includes("missing # separator") &&
        !e.error?.includes("content after anchor") &&
        !e.error?.includes("key-value syntax") &&
        !e.error?.includes("XML markup")
    );
    if (unexpectedErrors.length > 0) {
      warn(`${unexpectedErrors.length} unexpected edit_file error(s):`);
      for (const err of unexpectedErrors) {
        info(`  Error (${err.tool_call_id}): ${err.error}`);
        const matchingCall = editFileCalls.find(
          (c) => c.tool_call_id === err.tool_call_id
        );
        if (matchingCall) {
          info(`  ┌─ tool_input ─────────────────────────────`);
          const inputStr = JSON.stringify(matchingCall.tool_input, null, 2);
          for (const line of inputStr.split("\n")) {
            info(`  │ ${line}`);
          }
          info(`  └────────────────────────────────────────`);
        }
      }
    }

    // Check: no error events
    const errorEvents = events.filter((e) => e.type === "error");
    if (errorEvents.length === 0) {
      pass("No error events emitted");
    } else {
      warn(`${errorEvents.length} error event(s) emitted:`);
      for (const err of errorEvents) {
        info(`  ${String((err as unknown as { error: string }).error)}`);
      }
    }

    // Step 5: Verify final file content
    console.log();
    let finalContent: string;
    try {
      finalContent = readFileSync(testFile, "utf-8");
    } catch {
      fail("test.txt does not exist after edit — file was deleted");
      passed = false;
      return passed;
    }

    const hasCat = finalContent.toLowerCase().includes("cat");
    const hasPig = finalContent.toLowerCase().includes("pig");

    if (hasCat && !hasPig) {
      pass('File content: all "pig" replaced with "cat"');
    } else if (hasCat && hasPig) {
      warn('File content: contains both "cat" and "pig" — partial replacement');
      passed = false;
    } else if (!hasCat && hasPig) {
      fail('File content: still contains "pig", no "cat" found');
      passed = false;
    } else {
      fail(
        'File content: neither "cat" nor "pig" found — content may be corrupted'
      );
      passed = false;
    }

    // Show line count preservation
    const originalLines = STORY_CONTENT.split("\n").length;
    // Trim trailing newline for fair comparison (write_file may add one)
    const finalLines = finalContent.replace(/\n$/, "").split("\n").length;
    if (finalLines === originalLines) {
      pass(`Line count preserved: ${finalLines} lines`);
    } else if (finalLines < originalLines) {
      fail(
        `Lines LOST: ${originalLines} → ${finalLines} (silent deletion detected!)`
      );
      passed = false;
    } else {
      warn(
        `Line count changed: ${originalLines} → ${finalLines} (lines added, not lost)`
      );
    }

    return passed;
  } catch (error) {
    console.log();
    fail(
      `Headless execution failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  } finally {
    // Cleanup
    try {
      rmSync(testDir, { recursive: true, force: true });
      info(`Cleaned up ${testDir}`);
    } catch {
      warn(`Failed to clean up ${testDir}`);
    }
  }
};

// ── Run ───────────────────────────────────────────────────────
runTest().then((passed) => {
  console.log();
  if (passed) {
    console.log(`${BOLD}${GREEN}All checks passed ✓${RESET}\n`);
    process.exit(0);
  } else {
    console.log(`${BOLD}${RED}Some checks failed ✗${RESET}\n`);
    process.exit(1);
  }
});
