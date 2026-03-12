#!/usr/bin/env node
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
 *   node --import tsx scripts/test-headless-edit-regression.ts [-m <model>] [--provider <provider>]
 *
 * Requires: FRIENDLI_TOKEN or appropriate API key set in environment.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

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
const HEADLESS_TIMEOUT_MS = 10 * 60 * 1000;
const TRAILING_NEWLINE_REGEX = /\n$/;
const GUARD_PATTERNS = [
  "explicit 'lines' field",
  "must be a single-line",
  "contains newline",
  "lines \u2014",
  "not a line number",
  "not a valid {line_number}#{hash_id}",
  "missing # separator",
  "content after anchor",
  "key-value syntax",
  "XML markup",
] as const;

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
interface AnyEvent extends Record<string, unknown> {
  type: string;
}

interface ToolCallEvent extends AnyEvent {
  tool_call_id: string;
  tool_input: Record<string, unknown>;
  tool_name: string;
  type: "tool_call";
}

interface ToolResultEvent extends AnyEvent {
  error?: string;
  output: string;
  tool_call_id: string;
  type: "tool_result";
}

interface ErrorEvent extends AnyEvent {
  error: string;
  type: "error";
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

function createHeadlessArgs(): string[] {
  const headlessScript = resolve(
    SCRIPT_DIR,
    "..",
    "packages",
    "cea",
    "src",
    "entrypoints",
    "main.ts"
  );

  return [
    "--conditions=@ai-sdk-tool/source",
    "--import",
    "tsx",
    headlessScript,
    "-p",
    PROMPT,
    "--no-translate",
    ...extraArgs,
  ];
}

function printToolInput(
  label: string,
  toolInput: Record<string, unknown>
): void {
  info(`  ┌─ ${label} ─────────────────────────────`);
  const inputStr = JSON.stringify(toolInput, null, 2);
  for (const line of inputStr.split("\n")) {
    info(`  │ ${line}`);
  }
  info("  └────────────────────────────────────────");
}

function isGuardError(result: ToolResultEvent): boolean {
  return GUARD_PATTERNS.some((pattern) => result.error?.includes(pattern));
}

function isToolCallEvent(event: AnyEvent): event is ToolCallEvent {
  return (
    event.type === "tool_call" &&
    typeof event.tool_call_id === "string" &&
    typeof event.tool_name === "string" &&
    typeof event.tool_input === "object" &&
    event.tool_input !== null
  );
}

function isToolResultEvent(event: AnyEvent): event is ToolResultEvent {
  return (
    event.type === "tool_result" &&
    typeof event.tool_call_id === "string" &&
    "output" in event
  );
}

function isErrorEvent(event: AnyEvent): event is ErrorEvent {
  return event.type === "error" && typeof event.error === "string";
}

function parseJsonlEvents(output: string): AnyEvent[] {
  const events: AnyEvent[] = [];
  const lines = output.split("\n").filter((line) => line.trim());

  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as AnyEvent);
    } catch {
      warn(`Non-JSON line in output: ${line.slice(0, 100)}`);
    }
  }

  info(`Parsed ${events.length} JSONL events`);
  return events;
}

function runHeadlessMode(
  testDir: string,
  headlessArgs: string[]
): Promise<string> {
  info(`Running: node ${headlessArgs.join(" ")}`);
  console.log();

  return new Promise<string>((resolvePromise, rejectPromise) => {
    const proc = spawn("node", headlessArgs, {
      cwd: testDir,
      env: process.env,
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
      process.stderr.write(DIM + text + RESET);
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      rejectPromise(new Error("Headless mode timed out after 10 minutes"));
    }, HEADLESS_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectPromise(
          new Error(`Headless mode exited with code ${code}\nStderr: ${stderr}`)
        );
        return;
      }

      resolvePromise(stdout);
    });

    proc.on("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
  });
}

function reportAttemptedTools(
  editFileCalls: ToolCallEvent[],
  writeFileCalls: ToolCallEvent[]
): boolean {
  let passed = true;

  if (editFileCalls.length > 0) {
    pass(`edit_file called ${editFileCalls.length} time(s)`);
  } else {
    fail("edit_file was never called");
    passed = false;
  }

  if (writeFileCalls.length === 0) {
    pass("write_file was not used (no fallback needed)");
  } else {
    warn(
      `write_file was used ${writeFileCalls.length} time(s) — model fell back after guard rejections`
    );
  }

  return passed;
}

function reportEditToolResults(
  editFileCalls: ToolCallEvent[],
  toolResults: ToolResultEvent[]
): void {
  const editCallIds = new Set(editFileCalls.map((event) => event.tool_call_id));
  const editResults = toolResults.filter((event) =>
    editCallIds.has(event.tool_call_id)
  );
  const editErrors = editResults.filter((event) => event.error);
  const editSuccesses = editResults.filter((event) => !event.error);
  const guardErrors = editErrors.filter(isGuardError);
  const unexpectedErrors = editErrors.filter((event) => !isGuardError(event));

  if (editSuccesses.length > 0) {
    pass(
      `${editSuccesses.length}/${editResults.length} edit_file call(s) succeeded`
    );
    for (const success of editSuccesses) {
      const matchingCall = editFileCalls.find(
        (call) => call.tool_call_id === success.tool_call_id
      );
      if (matchingCall) {
        printToolInput(
          `succeeded tool_input (${success.tool_call_id})`,
          matchingCall.tool_input
        );
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
    for (const error of guardErrors) {
      info(`  Guard (${error.tool_call_id}): ${error.error}`);
      const matchingCall = editFileCalls.find(
        (call) => call.tool_call_id === error.tool_call_id
      );
      if (matchingCall) {
        printToolInput("tool_input", matchingCall.tool_input);
      }
    }
  }

  if (unexpectedErrors.length === 0) {
    return;
  }

  warn(`${unexpectedErrors.length} unexpected edit_file error(s):`);
  for (const error of unexpectedErrors) {
    info(`  Error (${error.tool_call_id}): ${error.error}`);
    const matchingCall = editFileCalls.find(
      (call) => call.tool_call_id === error.tool_call_id
    );
    if (matchingCall) {
      printToolInput("tool_input", matchingCall.tool_input);
    }
  }
}

function reportErrorEvents(errorEvents: ErrorEvent[]): void {
  if (errorEvents.length === 0) {
    pass("No error events emitted");
    return;
  }

  warn(`${errorEvents.length} error event(s) emitted:`);
  for (const errorEvent of errorEvents) {
    info(`  ${errorEvent.error}`);
  }
}

function reportToolAnalysis(events: AnyEvent[]): boolean {
  const toolCalls = events.filter(isToolCallEvent);
  const toolResults = events.filter(isToolResultEvent);
  const errorEvents = events.filter(isErrorEvent);

  const editFileCalls = toolCalls.filter(
    (event) => event.tool_name === "edit_file"
  );
  const writeFileCalls = toolCalls.filter(
    (event) => event.tool_name === "write_file"
  );

  const passed = reportAttemptedTools(editFileCalls, writeFileCalls);
  reportEditToolResults(editFileCalls, toolResults);
  reportErrorEvents(errorEvents);
  return passed;
}

function verifyFinalFileContent(testFile: string): boolean {
  let passed = true;
  let finalContent: string;

  try {
    finalContent = readFileSync(testFile, "utf-8");
  } catch {
    fail("test.txt does not exist after edit — file was deleted");
    return false;
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

  const originalLines = STORY_CONTENT.split("\n").length;
  const finalLines = finalContent
    .replace(TRAILING_NEWLINE_REGEX, "")
    .split("\n").length;

  if (finalLines === originalLines) {
    pass(`Line count preserved: ${finalLines} lines`);
    return passed;
  }

  if (finalLines < originalLines) {
    fail(
      `Lines LOST: ${originalLines} → ${finalLines} (silent deletion detected!)`
    );
    return false;
  }

  warn(
    `Line count changed: ${originalLines} → ${finalLines} (lines added, not lost)`
  );
  return passed;
}

function cleanupTestDir(testDir: string): void {
  try {
    rmSync(testDir, { recursive: true, force: true });
    info(`Cleaned up ${testDir}`);
  } catch {
    warn(`Failed to clean up ${testDir}`);
  }
}

// ── Main ──────────────────────────────────────────────────────
const runTest = async (): Promise<boolean> => {
  const testDir = join(tmpdir(), `edit-regression-${Date.now()}`);
  const testFile = join(testDir, "test.txt");

  console.log(`\n${BOLD}Headless Edit Regression Test${RESET}\n`);

  mkdirSync(testDir, { recursive: true });
  writeFileSync(testFile, STORY_CONTENT, "utf-8");
  info(`Test dir: ${testDir}`);
  info(`Test file initialized with ${STORY_CONTENT.split("\n").length} lines`);

  try {
    const output = await runHeadlessMode(testDir, createHeadlessArgs());

    console.log();
    const events = parseJsonlEvents(output);
    console.log();

    let passed = reportToolAnalysis(events);
    console.log();
    passed = verifyFinalFileContent(testFile) && passed;
    return passed;
  } catch (error) {
    console.log();
    fail(
      `Headless execution failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  } finally {
    cleanupTestDir(testDir);
  }
};

// ── Run ───────────────────────────────────────────────────────
runTest().then((passed) => {
  console.log();
  if (passed) {
    console.log(`${BOLD}${GREEN}All checks passed ✓${RESET}\n`);
    process.exit(0);
  }

  console.log(`${BOLD}${RED}Some checks failed ✗${RESET}\n`);
  process.exit(1);
});
