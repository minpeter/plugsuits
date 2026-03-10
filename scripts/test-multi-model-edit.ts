#!/usr/bin/env bun
/**
 * Multi-model edit_file test runner
 *
 * Runs test-headless-edit-ops.ts against every available model
 * and produces a summary table.
 *
 * Usage:
 *   bun run scripts/test-multi-model-edit.ts [--timeout <seconds>]
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

// ── Models ────────────────────────────────────────────────────
const MODELS = [
  { id: "MiniMaxAI/MiniMax-M2.5", short: "M2.5" },
  // { id: "MiniMaxAI/MiniMax-M2.1", short: "M2.1" },  // masked: slow + timeout-prone
  { id: "zai-org/GLM-5", short: "GLM-5" },
];

// ── CLI args ──────────────────────────────────────────────────
let perModelTimeoutSec = 900; // 15 min default per model (5 tests)
const rawArgs = process.argv.slice(2);
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--timeout" && i + 1 < rawArgs.length) {
    perModelTimeoutSec = Number.parseInt(rawArgs[i + 1], 10);
    i++;
  }
}

// ── Colors ────────────────────────────────────────────────────
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const ANSI_ESCAPE = "\u001b";
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");
const TEST_NAME_REGEX = /^\s*(\d+\.\s+.+)$/;
const PASS_PREFIX_REGEX = /^\s*PASS\s*—?\s*/;
const FAIL_PREFIX_REGEX = /^\s*FAIL\s*—?\s*/;
const ERROR_PREFIX_REGEX = /^\s*ERROR\s*—?\s*/;

// ── Types ─────────────────────────────────────────────────────
interface TestResult {
  detail: string;
  name: string;
  passed: boolean;
}

interface ModelResult {
  durationMs: number;
  error?: string;
  modelId: string;
  modelShort: string;
  tests: TestResult[];
  totalPassed: number;
  totalTests: number;
}

function getResultColor(totalPassed: number, totalTests: number): string {
  if (totalPassed === totalTests) {
    return GREEN;
  }

  if (totalPassed > 0) {
    return YELLOW;
  }

  return RED;
}

function printModelTests(tests: TestResult[]): void {
  for (const test of tests) {
    const icon = test.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`    ${icon} ${test.name}`);
  }
}

function printModelRunResult(result: ModelResult): void {
  const timeStr = `${(result.durationMs / 1000).toFixed(1)}s`;
  if (result.error) {
    console.log(`  ${RED}ERROR${RESET}: ${result.error} (${timeStr})`);
    return;
  }

  const color = getResultColor(result.totalPassed, result.totalTests);
  console.log(
    `  ${color}${result.totalPassed}/${result.totalTests} passed${RESET} (${timeStr})`
  );
  printModelTests(result.tests);
}

function printSummary(allResults: ModelResult[]): void {
  console.log(`${BOLD}═══ Summary ═══${RESET}\n`);

  for (const result of allResults) {
    const timeStr = `${(result.durationMs / 1000).toFixed(0)}s`;
    const color = getResultColor(result.totalPassed, result.totalTests);
    console.log(
      `  ${result.modelShort.padEnd(8)} ${color}${result.totalPassed}/${result.totalTests}${RESET} (${timeStr})`
    );
    printModelTests(result.tests);
  }

  console.log();

  const totalModels = allResults.length;
  const perfectModels = allResults.filter(
    (result) => !result.error && result.totalPassed === result.totalTests
  ).length;
  console.log(
    `${BOLD}Models with 100%: ${perfectModels}/${totalModels}${RESET}`
  );

  const validResults = allResults.filter((result) => !result.error);
  const overallPassed = validResults.reduce(
    (sum, result) => sum + result.totalPassed,
    0
  );
  const overallTotal = validResults.reduce(
    (sum, result) => sum + result.totalTests,
    0
  );
  const successRate =
    overallTotal > 0 ? Math.round((overallPassed / overallTotal) * 100) : 0;

  console.log(
    `${BOLD}Overall: ${overallPassed}/${overallTotal} (${successRate}%)${RESET}`
  );
  console.log();

  if (perfectModels === totalModels && totalModels > 0) {
    console.log(`${BOLD}${GREEN}🎉 ALL MODELS PASSED ALL TESTS!${RESET}\n`);
    process.exit(0);
  }

  console.log(
    `${BOLD}${YELLOW}Some models have failures. See details above.${RESET}\n`
  );
  process.exit(1);
}

// ── Parse test-headless-edit-ops stdout ───────────────────────
function parseOpsOutput(stdout: string): TestResult[] {
  const results: TestResult[] = [];

  // Match lines like: "  PASS — edit_file: 1/1 succeeded, 32.5s"
  // or "  FAIL — edit_file: 0/3 succeeded, 15.2s"
  // or "  ERROR — Timed out after 10 minutes"
  // Following a line like: "1. Replace single line"
  const lines = stdout.split("\n");

  let currentTestName = "";
  for (const line of lines) {
    // Detect test name: starts with ANSI-colored bold cyan + "N. Name"
    // Strip ANSI codes for matching
    const stripped = line.replace(ANSI_ESCAPE_REGEX, "");

    // Test name pattern: "N. <name>"
    const testNameMatch = stripped.match(TEST_NAME_REGEX);
    if (
      testNameMatch &&
      !stripped.includes("—") &&
      !stripped.includes("✓") &&
      !stripped.includes("✗")
    ) {
      currentTestName = testNameMatch[1].trim();
      continue;
    }

    // Result line: PASS/FAIL/ERROR
    if (currentTestName && stripped.includes("PASS")) {
      const detail = stripped.replace(PASS_PREFIX_REGEX, "").trim();
      results.push({
        name: currentTestName,
        passed: true,
        detail: detail || "passed",
      });
      currentTestName = "";
    } else if (currentTestName && stripped.includes("FAIL")) {
      const detail = stripped.replace(FAIL_PREFIX_REGEX, "").trim();
      results.push({
        name: currentTestName,
        passed: false,
        detail: detail || "failed",
      });
      currentTestName = "";
    } else if (currentTestName && stripped.includes("ERROR")) {
      const detail = stripped.replace(ERROR_PREFIX_REGEX, "").trim();
      results.push({
        name: currentTestName,
        passed: false,
        detail: detail || "error",
      });
      currentTestName = "";
    }
  }

  return results;
}

// ── Run one model ────────────────────────────────────────────
function runModel(model: { id: string; short: string }): Promise<ModelResult> {
  const opsScript = resolve(import.meta.dir, "test-headless-edit-ops.ts");
  const startTime = Date.now();

  return new Promise<ModelResult>((resolvePromise) => {
    const proc = spawn(
      "bun",
      ["run", opsScript, "-m", model.id, "--no-translate"],
      {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, BUN_INSTALL: process.env.BUN_INSTALL },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", () => {
      // Drain stderr to avoid backpressure; the runner reports timeout/spawn errors separately.
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolvePromise({
        modelId: model.id,
        modelShort: model.short,
        tests: [],
        totalPassed: 0,
        totalTests: 0,
        durationMs: Date.now() - startTime,
        error: `Timed out after ${perModelTimeoutSec}s`,
      });
    }, perModelTimeoutSec * 1000);

    proc.on("close", () => {
      clearTimeout(timeout);
      const tests = parseOpsOutput(stdout);
      const totalPassed = tests.filter((t) => t.passed).length;

      resolvePromise({
        modelId: model.id,
        modelShort: model.short,
        tests,
        totalPassed,
        totalTests: Math.max(tests.length, 5),
        durationMs: Date.now() - startTime,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolvePromise({
        modelId: model.id,
        modelShort: model.short,
        tests: [],
        totalPassed: 0,
        totalTests: 0,
        durationMs: Date.now() - startTime,
        error: err.message,
      });
    });
  });
}

// ── Main ──────────────────────────────────────────────────────
const main = async () => {
  console.log(`\n${BOLD}═══ Multi-Model edit_file Test Runner ═══${RESET}\n`);
  console.log(`${DIM}Models: ${MODELS.map((m) => m.short).join(", ")}${RESET}`);
  console.log(`${DIM}Timeout: ${perModelTimeoutSec}s per model${RESET}`);
  console.log();

  const allResults: ModelResult[] = [];

  for (const model of MODELS) {
    console.log(`${CYAN}${BOLD}▶ Testing ${model.short} (${model.id})${RESET}`);
    const result = await runModel(model);
    allResults.push(result);
    printModelRunResult(result);
    console.log();
  }
  printSummary(allResults);
};

main();
