#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(SCRIPT_DIR, "..");
const HEADLESS_SCRIPT = resolvePath(
  REPO_ROOT,
  "packages",
  "cea",
  "src",
  "entrypoints",
  "main.ts"
);
const RESULTS_ROOT = resolvePath(REPO_ROOT, "results", "reliability");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RUNS = 10;
const DEFAULT_MAX_ITERATIONS = 30;

type ScenarioId = "bug-trace" | "multi-file-refactor";

interface Scenario {
  id: ScenarioId;
  prompt: string;
}

const SCENARIOS: Record<ScenarioId, Scenario> = {
  "bug-trace": {
    id: "bug-trace",
    prompt:
      "packages/harness/src/compaction-orchestrator.ts 에서 blockAtHardLimit이 호출되는 전체 흐름을 추적해줘. 어디서 호출되고, 어떤 조건에서 blocking이 발생하고, compaction이 실패하면 어떻게 되는지 상세하게 분석해줘.",
  },
  "multi-file-refactor": {
    id: "multi-file-refactor",
    prompt:
      "packages/harness/src/index.ts에서 export되는 모든 public API를 분석해줘. 각 export가 어떤 파일에서 오는지, 어떤 타입인지 (function/class/type/const), 그리고 packages/cea, packages/headless, packages/tui 중 어디서 사용되는지 매핑해줘.",
  },
};

interface TrajectoryEvent {
  error?: string;
  message?: string;
  observation?: {
    results?: Array<{ content: string; source_call_id: string }>;
  };
  source?: string;
  tool_calls?: Array<{
    arguments: Record<string, unknown>;
    function_name: string;
    tool_call_id: string;
  }>;
  type: string;
}

interface ReliabilityRow {
  assistantTurns: number;
  completed: boolean;
  contextLimit: number;
  durationMs: number;
  exitCode: number | null;
  failureClass: string;
  finalAssistantText: string;
  modelId: string;
  promptHash: string;
  provider: string;
  repoSha: string;
  runId: string;
  runIndex: number;
  scenarioId: ScenarioId;
  timedOut: boolean;
  toolCallCount: number;
  outputLogPath: string;
}

interface HarnessConfig {
  limits: number[];
  maxIterations: number;
  modelId: string;
  provider: string;
  runs: number;
  scenarioIds: ScenarioId[];
  timeoutMs: number;
}

function parseArg(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function getArgList(flag: string): string[] | undefined {
  const value = parseArg(flag);
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;
}

function hashText(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function tryParseJson<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

function parseTrajectory(stdout: string): TrajectoryEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => tryParseJson<TrajectoryEvent>(line))
    .filter((event): event is TrajectoryEvent => event !== null);
}

function classifyFailure(params: {
  completed: boolean;
  events: TrajectoryEvent[];
  exitCode: number | null;
  timedOut: boolean;
}): string {
  if (params.completed) {
    return "success";
  }
  if (params.timedOut) {
    return "timeout";
  }
  const lastError = [...params.events]
    .reverse()
    .find((event) => event.type === "error")?.error;
  if (lastError?.includes("Max iterations")) {
    return "max_iterations";
  }
  if (lastError?.includes("No output generated")) {
    return "no_output";
  }
  if (lastError) {
    return "error_event";
  }
  if ((params.exitCode ?? 0) !== 0) {
    return "exit_code_nonzero";
  }
  if (
    !params.events.some(
      (event) => event.type === "step" && event.source === "agent"
    )
  ) {
    return "no_assistant";
  }
  return "unknown_incomplete";
}

function getLastItem<T>(items: T[]): T | undefined {
  const lastIndex = items.length - 1;
  return lastIndex >= 0 ? items[lastIndex] : undefined;
}

function readConfig(): HarnessConfig {
  return {
    limits: (getArgList("--limits") ?? ["128000", "200000"]).map(Number),
    maxIterations: Number(
      parseArg("--max-iterations") ?? DEFAULT_MAX_ITERATIONS
    ),
    modelId: parseArg("-m") ?? parseArg("--model") ?? "claude-sonnet-4-6",
    provider: parseArg("--provider") ?? "anthropic",
    runs: Number(parseArg("--runs") ?? DEFAULT_RUNS),
    scenarioIds: (getArgList("--scenarios") ?? [
      "bug-trace",
      "multi-file-refactor",
    ]) as ScenarioId[],
    timeoutMs: Number(parseArg("--timeout-ms") ?? DEFAULT_TIMEOUT_MS),
  };
}

function buildRow(params: {
  completed: boolean;
  contextLimit: number;
  events: TrajectoryEvent[];
  modelId: string;
  prompt: string;
  provider: string;
  repoSha: string;
  result: { durationMs: number; exitCode: number | null; timedOut: boolean };
  runId: string;
  runIndex: number;
  scenarioId: ScenarioId;
  outputLogPath: string;
}): ReliabilityRow {
  const assistantEvents = params.events.filter(
    (event) => event.type === "step" && event.source === "agent"
  );
  const toolCalls = assistantEvents.flatMap((event) => event.tool_calls ?? []);

  return {
    assistantTurns: assistantEvents.length,
    completed: params.completed,
    contextLimit: params.contextLimit,
    durationMs: params.result.durationMs,
    exitCode: params.result.exitCode,
    failureClass: classifyFailure({
      completed: params.completed,
      events: params.events,
      exitCode: params.result.exitCode,
      timedOut: params.result.timedOut,
    }),
    finalAssistantText: getLastItem(assistantEvents)?.message ?? "",
    modelId: params.modelId,
    promptHash: hashText(params.prompt),
    provider: params.provider,
    repoSha: params.repoSha,
    runId: params.runId,
    runIndex: params.runIndex,
    scenarioId: params.scenarioId,
    timedOut: params.result.timedOut,
    toolCallCount: toolCalls.length,
    outputLogPath: params.outputLogPath,
  };
}

async function spawnRun(params: {
  contextLimit: number;
  maxIterations: number;
  modelId: string;
  provider: string;
  prompt: string;
  timeoutMs: number;
}): Promise<{
  durationMs: number;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}> {
  const nodeArgs = [
    "--conditions=@ai-sdk-tool/source",
    "--import",
    "tsx",
    HEADLESS_SCRIPT,
    "-p",
    params.prompt,
    "--no-translate",
    "--max-iterations",
    String(params.maxIterations),
    "-m",
    params.modelId,
    "--provider",
    params.provider,
  ];

  const env = {
    ...process.env,
    COMPACTION_DEBUG: "1",
    CONTEXT_LIMIT_OVERRIDE: String(params.contextLimit),
  };

  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("node", nodeArgs, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

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
    }, params.timeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        durationMs: Date.now() - startedAt,
        exitCode,
        stderr,
        stdout,
        timedOut,
      });
    });

    child.on("error", reject);
  });
}

function buildMarkdown(rows: ReliabilityRow[]): string {
  const lines = [
    "# Reliability Harness Report",
    "",
    "| scenario | limit | run | completed | failure | assistant_turns | tool_calls | duration |",
    "|---|---:|---:|:---:|---|---:|---:|---:|",
  ];

  for (const row of rows) {
    lines.push(
      `| ${row.scenarioId} | ${row.contextLimit} | ${row.runIndex} | ${row.completed ? "yes" : "no"} | ${row.failureClass} | ${row.assistantTurns} | ${row.toolCallCount} | ${row.durationMs} |`
    );
  }

  lines.push("", "## Failure Summary", "");
  const grouped = new Map<string, number>();
  for (const row of rows) {
    grouped.set(row.failureClass, (grouped.get(row.failureClass) ?? 0) + 1);
  }
  for (const [failureClass, count] of grouped) {
    lines.push(`- ${failureClass}: ${count}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const config = readConfig();
  const repoSha = process.env.GIT_COMMIT_SHA ?? "unknown";
  const startedAt = new Date().toISOString().replace(/:/g, "-");
  const outDir = resolvePath(RESULTS_ROOT, startedAt);

  mkdirSync(outDir, { recursive: true });

  const rows: ReliabilityRow[] = [];

  for (const scenarioId of config.scenarioIds) {
    const scenario = SCENARIOS[scenarioId];
    if (!scenario) {
      continue;
    }

    for (const contextLimit of config.limits) {
      for (let runIndex = 1; runIndex <= config.runs; runIndex += 1) {
        const runId = `${scenarioId}-${contextLimit}-run${runIndex}`;
        const result = await spawnRun({
          contextLimit,
          maxIterations: config.maxIterations,
          modelId: config.modelId,
          provider: config.provider,
          prompt: scenario.prompt,
          timeoutMs: config.timeoutMs,
        });

        const outputLogPath = resolvePath(outDir, `${runId}.output.jsonl`);
        const stderrPath = resolvePath(outDir, `${runId}.stderr.log`);
        writeFileSync(outputLogPath, result.stdout, "utf8");
        writeFileSync(stderrPath, result.stderr, "utf8");

        const events = parseTrajectory(result.stdout);
        const assistantEvents = events.filter(
          (event) => event.type === "step" && event.source === "agent"
        );
        const completed =
          !result.timedOut &&
          (result.exitCode ?? 0) === 0 &&
          !events.some((event) => event.type === "error") &&
          assistantEvents.length > 0;

        rows.push(
          buildRow({
            completed,
            contextLimit,
            events,
            modelId: config.modelId,
            prompt: scenario.prompt,
            provider: config.provider,
            repoSha,
            result,
            runId,
            runIndex,
            scenarioId,
            outputLogPath,
          })
        );
      }
    }
  }

  writeFileSync(
    resolvePath(outDir, "reliability-report.json"),
    JSON.stringify(rows, null, 2),
    "utf8"
  );
  writeFileSync(
    resolvePath(outDir, "reliability-report.md"),
    buildMarkdown(rows),
    "utf8"
  );

  console.log(`Reliability harness wrote ${rows.length} runs to ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
