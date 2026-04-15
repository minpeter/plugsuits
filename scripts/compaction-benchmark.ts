#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(SCRIPT_DIR, "..");
const HEADLESS_SCRIPT = resolvePath(
  SCRIPT_DIR,
  "..",
  "packages",
  "cea",
  "src",
  "entrypoints",
  "main.ts"
);
const RESULTS_DIR = resolvePath(REPO_ROOT, "results");
const PROMPT = "코드베이스를 탐색하고, 이 코드 베이스에 대해서 설명해줘";
const CONTEXT_LIMITS = [8000, 20_000, 40_000, 80_000] as const;
const MAX_ITERATIONS = 40;
const SCENARIO_TIMEOUT_MS = 10 * 60 * 1000;

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const extraArgs: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--dry-run") {
    continue;
  }

  if (
    (arg === "-m" || arg === "--model" || arg === "--provider") &&
    i + 1 < args.length
  ) {
    extraArgs.push(arg, args[i + 1]);
    i++;
  }
}

interface BaseMetricEvent {
  event: string;
  ts?: number;
  turn?: number;
}

interface TurnCompleteMetricEvent extends BaseMetricEvent {
  actualTokens?: number | null;
  estimatedTokens?: number | null;
  event: "turn_complete";
}

interface CompactionCompleteMetricEvent extends BaseMetricEvent {
  event: "compaction_complete";
  success?: boolean;
}

interface ScenarioResult {
  blockingEventCount: number;
  compactionCount: number;
  completed: boolean;
  contextLimit: number;
  durationMs: number;
  exitCode: number | null;
  maxTokensUsed: number;
  metricsPath: string;
  timedOut: boolean;
  outputLogPath: string;
}

interface SpawnResult {
  durationMs: number;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

function getScenarioPaths(contextLimit: number): {
  metricsPath: string;
  outputLogPath: string;
} {
  return {
    outputLogPath: resolvePath(
      RESULTS_DIR,
      `scenario-${contextLimit}-output.jsonl`
    ),
    metricsPath: resolvePath(
      RESULTS_DIR,
      `scenario-${contextLimit}-metrics.log`
    ),
  };
}

function tryParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseMetricsLog(content: string): BaseMetricEvent[] {
  const events: BaseMetricEvent[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[compaction-metric]")) {
      continue;
    }

    const jsonStr = trimmed.slice("[compaction-metric]".length).trim();
    const parsed = tryParseJson<BaseMetricEvent>(jsonStr);
    if (parsed) {
      events.push(parsed);
    }
  }

  return events;
}

function parseTrajectoryEvents(content: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    const parsed = tryParseJson<Record<string, unknown>>(trimmed);
    if (parsed && typeof parsed === "object") {
      events.push(parsed);
    }
  }

  return events;
}

function getMaxTokensUsed(events: BaseMetricEvent[]): number {
  let maxTokensUsed = 0;

  for (const event of events) {
    if (event.event !== "turn_complete") {
      continue;
    }

    const turnEvent = event as TurnCompleteMetricEvent;
    const candidate =
      turnEvent.actualTokens ?? turnEvent.estimatedTokens ?? maxTokensUsed;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      maxTokensUsed = Math.max(maxTokensUsed, candidate);
    }
  }

  return maxTokensUsed;
}

function isCompleted(
  trajectoryContent: string,
  exitCode: number | null,
  timedOut: boolean
): boolean {
  if (timedOut || exitCode !== 0) {
    return false;
  }

  const events = parseTrajectoryEvents(trajectoryContent);
  const hasErrorEvent = events.some((event) => event.type === "error");
  const hasAssistantEvent = events.some(
    (event) => event.type === "step" && event.source === "agent"
  );

  return !hasErrorEvent && hasAssistantEvent;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function buildSummary(
  results: ScenarioResult[],
  totalDurationMs: number
): string {
  const lines = [
    "Compaction Benchmark Summary",
    `Generated: ${new Date().toISOString()}`,
    `Prompt: ${PROMPT}`,
    `Max iterations per scenario: ${MAX_ITERATIONS}`,
    "",
    "Per scenario:",
    "limit | compaction_count | max_tokens_used | blocking_event_count | completed | duration | exit_code",
  ];

  for (const result of results) {
    lines.push(
      [
        result.contextLimit,
        result.compactionCount,
        result.maxTokensUsed,
        result.blockingEventCount,
        result.completed ? "yes" : "no",
        formatDuration(result.durationMs),
        result.exitCode ?? "null",
      ].join(" | ")
    );
    lines.push(`  output_log: ${result.outputLogPath}`);
    lines.push(`  metrics: ${result.metricsPath}`);
  }

  lines.push("");
  lines.push(
    `Total run time: ${formatDuration(totalDurationMs)} (${totalDurationMs}ms)`
  );

  return `${lines.join("\n")}\n`;
}

async function spawnScenario(contextLimit: number): Promise<SpawnResult> {
  const nodeArgs = [
    "--conditions=@ai-sdk-tool/source",
    "--import",
    "tsx",
    HEADLESS_SCRIPT,
    "-p",
    PROMPT,
    "--no-translate",
    "--max-iterations",
    String(MAX_ITERATIONS),
    ...extraArgs,
  ];

  const env = {
    ...process.env,
    BENCHMARK_SEED: process.env.BENCHMARK_SEED ?? "7",
    BENCHMARK_TEMPERATURE: process.env.BENCHMARK_TEMPERATURE ?? "0",
    COMPACTION_DEBUG: "1",
    CONTEXT_LIMIT_OVERRIDE: String(contextLimit),
  };

  return await new Promise<SpawnResult>((resolveResult, reject) => {
    const startedAt = Date.now();
    const child = spawn("node", nodeArgs, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");

      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000).unref();
    }, SCENARIO_TIMEOUT_MS);

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolveResult({
        stdout,
        stderr,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function runScenario(contextLimit: number): Promise<ScenarioResult> {
  const { outputLogPath, metricsPath } = getScenarioPaths(contextLimit);
  console.log(`\n▶ Running scenario ${contextLimit.toLocaleString()} tokens`);

  const result = await spawnScenario(contextLimit);
  writeFileSync(outputLogPath, result.stdout, "utf-8");
  writeFileSync(metricsPath, result.stderr, "utf-8");

  const metricEvents = parseMetricsLog(`${result.stdout}\n${result.stderr}`);
  const compactionCount = metricEvents.filter(
    (event) =>
      event.event === "compaction_complete" &&
      (event as CompactionCompleteMetricEvent).success !== false
  ).length;
  const blockingEventCount = metricEvents.filter(
    (event) => event.event === "blocking_start"
  ).length;
  const maxTokensUsed = getMaxTokensUsed(metricEvents);
  const completed = isCompleted(
    result.stdout,
    result.exitCode,
    result.timedOut
  );

  console.log(`  ✓ Saved output_log=${outputLogPath} metrics=${metricsPath}`);
  console.log(
    `  ↳ compactions=${compactionCount}, max_tokens_used=${maxTokensUsed}, blocking=${blockingEventCount}, completed=${completed ? "yes" : "no"}`
  );

  if (result.timedOut) {
    console.error(
      `  ⚠ Scenario ${contextLimit.toLocaleString()} timed out after ${formatDuration(SCENARIO_TIMEOUT_MS)}`
    );
  }

  return {
    contextLimit,
    compactionCount,
    maxTokensUsed,
    blockingEventCount,
    completed,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputLogPath,
    metricsPath,
  };
}

async function main(): Promise<void> {
  console.log("\n🧪 Compaction Benchmark Runner\n");
  console.log(`Results dir: ${RESULTS_DIR}`);
  console.log(`Headless script: ${HEADLESS_SCRIPT}`);
  console.log(`Prompt: ${PROMPT}`);

  if (isDryRun) {
    console.log("\n🔍 Dry run — no agent processes will be started.\n");

    for (const contextLimit of CONTEXT_LIMITS) {
      const { outputLogPath, metricsPath } = getScenarioPaths(contextLimit);
      console.log(`Scenario ${contextLimit.toLocaleString()}:`);
      console.log(
        `  env: COMPACTION_DEBUG=1 CONTEXT_LIMIT_OVERRIDE=${contextLimit}`
      );
      console.log(
        `  cmd: node --conditions=@ai-sdk-tool/source --import tsx ${HEADLESS_SCRIPT} -p "${PROMPT}" --no-translate --max-iterations ${MAX_ITERATIONS}`
      );
      console.log(`  output_log: ${outputLogPath}`);
      console.log(`  metrics: ${metricsPath}`);
      console.log();
    }

    console.log(
      `Summary path: ${resolvePath(RESULTS_DIR, "benchmark-summary.txt")}`
    );
    console.log("\n✅ Dry run complete");
    return;
  }

  mkdirSync(RESULTS_DIR, { recursive: true });

  const startedAt = Date.now();
  const results: ScenarioResult[] = [];
  for (const contextLimit of CONTEXT_LIMITS) {
    try {
      results.push(await runScenario(contextLimit));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { outputLogPath, metricsPath } = getScenarioPaths(contextLimit);
      writeFileSync(outputLogPath, "", "utf-8");
      writeFileSync(metricsPath, `${message}\n`, "utf-8");
      results.push({
        contextLimit,
        compactionCount: 0,
        maxTokensUsed: 0,
        blockingEventCount: 0,
        completed: false,
        durationMs: 0,
        exitCode: null,
        timedOut: false,
        outputLogPath,
        metricsPath,
      });
      console.error(
        `  ✗ Scenario ${contextLimit.toLocaleString()} failed: ${message}`
      );
    }
  }

  const totalDurationMs = Date.now() - startedAt;
  const summaryPath = resolvePath(RESULTS_DIR, "benchmark-summary.txt");
  const summary = buildSummary(results, totalDurationMs);
  writeFileSync(summaryPath, summary, "utf-8");

  console.log(`\n✅ Summary saved: ${summaryPath}`);
  console.log(`Total run time: ${formatDuration(totalDurationMs)}`);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
