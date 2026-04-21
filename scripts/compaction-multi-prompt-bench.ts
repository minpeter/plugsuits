#!/usr/bin/env node
/**
 * Multi-prompt compaction benchmark.
 *
 * Runs 5 diverse prompt scenarios at each context limit and captures metrics.
 * Usage:
 *   node --import tsx scripts/compaction-multi-prompt-bench.ts [--dry-run] [--limits 20000,40000]
 */
import { spawn } from "node:child_process";
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
const RESULTS_DIR = resolvePath(REPO_ROOT, "results", "multi-prompt");
const SCENARIO_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ITERATIONS = 40;

// ─── Prompt Scenarios ───────────────────────────────────────────────
interface PromptScenario {
  /** Short slug for file naming */
  id: string;
  /** Human-readable label */
  label: string;
  /** Expected behaviour pattern */
  pattern: "read-heavy" | "write-heavy" | "mixed" | "short" | "multi-step";
  /** The actual prompt sent to the agent */
  prompt: string;
}

const SCENARIOS: PromptScenario[] = [
  {
    id: "explore",
    label: "Codebase exploration (read-heavy)",
    prompt: "코드베이스를 탐색하고, 이 코드 베이스에 대해서 설명해줘",
    pattern: "read-heavy",
  },
  {
    id: "single-edit",
    label: "Single file edit (short task)",
    prompt:
      "packages/harness/src/compaction-types.ts 파일을 읽고, CompactionConfig 인터페이스에 있는 모든 필드를 JSDoc 주석으로 설명해줘. 파일을 직접 수정해서 JSDoc을 추가해.",
    pattern: "short",
  },
  {
    id: "bug-trace",
    label: "Bug investigation (read + trace)",
    prompt:
      "packages/harness/src/compaction-orchestrator.ts 에서 blockAtHardLimit이 호출되는 전체 흐름을 추적해줘. 어디서 호출되고, 어떤 조건에서 blocking이 발생하고, compaction이 실패하면 어떻게 되는지 상세하게 분석해줘. 작업 방식은 다음을 따라: (1) compaction-orchestrator.ts 정의부 확인, (2) headless runner와 tui에서 호출 지점 확인, (3) compaction-policy 또는 overflow 처리 유틸 한두 곳만 확인, (4) 충분한 근거가 모이면 즉시 답변. 같은 subtree에 대해 broad grep을 반복하지 말고, 필요한 파일만 좁게 읽어.",
    pattern: "read-heavy",
  },
  {
    id: "multi-file-refactor",
    label: "Multi-file analysis (cross-module)",
    prompt:
      "packages/harness/src/index.ts에서 export되는 모든 public API를 분석해줘. 각 export가 어떤 파일에서 오는지, 어떤 타입인지 (function/class/type/const), 그리고 packages/cea, packages/headless, packages/tui 중 어디서 사용되는지 매핑해줘. 작업 방식은 다음을 따라: (1) index.ts를 source of truth로 사용해 export 목록을 만든다, (2) export source file은 index.ts의 re-export 경로로 판별한다, (3) usages는 각 패키지에서 grep_files로 찾고, 필요할 때만 해당 파일을 read_file 한다, (4) harness의 모든 소스 파일을 전수로 읽지 말고 표를 작성할 수 있을 만큼의 근거가 모이면 바로 답한다.",
    pattern: "multi-step",
  },
  {
    id: "write-heavy",
    label: "Code generation (write-heavy)",
    prompt:
      "packages/harness/src/compaction-types.ts를 읽고, 모든 인터페이스와 타입에 대한 단위 테스트 파일 packages/harness/src/compaction-types.test.ts를 새로 작성해줘. 각 필드의 기본값, optional 여부, 타입 호환성을 테스트해야 해. 작업 방식은 다음을 따라: (1) 대상 타입 파일을 읽는다, (2) 기존 test 파일이 있으면 참고로 한 번만 읽는다, (3) 바로 테스트 파일을 작성한다, (4) 실패하면 에러 줄만 고친다. shell로 cat/head/wc 하지 말고 read_file와 테스트 실행 결과만 사용해.",
    pattern: "write-heavy",
  },
];

const SCENARIO_PRIORITY: PromptScenario["id"][] = [
  "write-heavy",
  "multi-file-refactor",
  "bug-trace",
  "explore",
  "single-edit",
] as const;

// ─── CLI Args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");

let CONTEXT_LIMITS = [8000, 20_000, 40_000, 80_000];
const limitsArgIdx = args.indexOf("--limits");
if (limitsArgIdx !== -1 && args[limitsArgIdx + 1]) {
  CONTEXT_LIMITS = args[limitsArgIdx + 1].split(",").map(Number);
}

let scenarioFilter: string[] | null = null;
const scenarioArgIdx = args.indexOf("--scenarios");
if (scenarioArgIdx !== -1 && args[scenarioArgIdx + 1]) {
  scenarioFilter = args[scenarioArgIdx + 1].split(",");
}

function readFlagValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const requestedParallelLimit = readFlagValue("--parallel-limit");
const staggerMs = Number(readFlagValue("--stagger-ms") ?? "750");
const MAX_ATTEMPTS_PER_CELL = 3;
const RETRY_COOLDOWN_MS = 8000;

const extraArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (
    [
      "--dry-run",
      "--limits",
      "--parallel",
      "--parallel-limit",
      "--scenarios",
      "--stagger-ms",
    ].includes(arg)
  ) {
    if (!["--dry-run", "--parallel"].includes(arg)) {
      i++;
    }
    continue;
  }
  if ((arg === "-m" || arg === "--model") && i + 1 < args.length) {
    extraArgs.push(arg, args[i + 1]);
    i++;
  }
}

// ─── Types ──────────────────────────────────────────────────────────
interface MetricEvent {
  actualTokens?: number | null;
  estimatedTokens?: number | null;
  event: string;
  promptTokens?: number | null;
  success?: boolean;
  tokensAfter?: number | null;
  tokensBefore?: number | null;
  ts?: number;
  turn?: number;
}

interface RunResult {
  blockingCount: number;
  compactionCount: number;
  completed: boolean;
  contextLimit: number;
  durationMs: number;
  exitCode: number | null;
  failureClass: string;
  maxTokensUsed: number;
  metricsPath: string;
  outputLogPath: string;
  probeMax: number;
  promptId: string;
  timedOut: boolean;
  turnCount: number;
}

interface PendingRun {
  contextLimit: number;
  scenario: PromptScenario;
}

function resolveParallelLimit(taskCount: number): number {
  if (requestedParallelLimit) {
    return Number(requestedParallelLimit);
  }

  const minContextLimit = Math.min(...CONTEXT_LIMITS);
  if (taskCount > 20 || minContextLimit < 64_000) {
    return 1;
  }

  return 3;
}

// ─── Helpers ────────────────────────────────────────────────────────
function tryParseJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function computeSeed(
  promptId: string,
  contextLimit: number,
  attempt: number
): string {
  const baseSeed = Number(process.env.BENCHMARK_SEED ?? "7");
  const promptHash = [...promptId].reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0
  );
  return String(baseSeed + promptHash + contextLimit + (attempt - 1));
}

function classifyOutcome(params: {
  exitCode: number | null;
  timedOut: boolean;
  trajEvents: Record<string, unknown>[];
}): { completed: boolean; failureClass: string } {
  const hasError = params.trajEvents.some((event) => event.type === "error");
  const hasAssistant = params.trajEvents.some(
    (event) => event.type === "step" && event.source === "agent"
  );
  const errorEvent = [...params.trajEvents]
    .reverse()
    .find((event) => event.type === "error");
  const errorText = String(errorEvent?.error ?? errorEvent?.content ?? "");

  if (!params.timedOut && params.exitCode === 0 && !hasError && hasAssistant) {
    return { completed: true, failureClass: "success" };
  }
  if (params.timedOut) {
    return { completed: false, failureClass: "timeout" };
  }
  if (errorText.includes("No output generated")) {
    return { completed: false, failureClass: "no_output" };
  }
  if (errorText.includes("Max iterations")) {
    return { completed: false, failureClass: "max_iterations" };
  }
  if (errorText.includes("terminated")) {
    return { completed: false, failureClass: "terminated" };
  }
  if (!hasAssistant) {
    return { completed: false, failureClass: "no_assistant" };
  }
  if (hasError) {
    return { completed: false, failureClass: "error_event" };
  }
  return { completed: false, failureClass: "unknown_incomplete" };
}

function parseMetrics(content: string): MetricEvent[] {
  const events: MetricEvent[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t.includes("[compaction-metric]")) {
      continue;
    }
    const jsonStr = t
      .slice(t.indexOf("[compaction-metric]") + "[compaction-metric]".length)
      .trim();
    const parsed = tryParseJson<MetricEvent>(jsonStr);
    if (parsed) {
      events.push(parsed);
    }
  }
  return events;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Spawn ──────────────────────────────────────────────────────────
async function spawnRun(
  prompt: string,
  contextLimit: number,
  promptId: string,
  attempt: number
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}> {
  const nodeArgs = [
    "--conditions=@ai-sdk-tool/source",
    "--import",
    "tsx",
    HEADLESS_SCRIPT,
    "-p",
    prompt,
    "--no-translate",
    "--max-iterations",
    String(MAX_ITERATIONS),
    ...extraArgs,
  ];

  const env = {
    ...process.env,
    BENCHMARK_SEED: computeSeed(promptId, contextLimit, attempt),
    BENCHMARK_TEMPERATURE: process.env.BENCHMARK_TEMPERATURE ?? "0",
    COMPACTION_DEBUG: "1",
    CONTEXT_LIMIT_OVERRIDE: String(contextLimit),
  };

  return await new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn("node", nodeArgs, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000).unref();
    }, SCENARIO_TIMEOUT_MS);

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - start,
      });
    });

    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ─── Run one combination ────────────────────────────────────────────
async function runOne(
  scenario: PromptScenario,
  contextLimit: number
): Promise<RunResult> {
  const tag = `${scenario.id}-${contextLimit}`;
  const outputLogPath = resolvePath(RESULTS_DIR, `${tag}-output.jsonl`);
  const metricsPath = resolvePath(RESULTS_DIR, `${tag}-metrics.log`);

  console.log(
    `\n▶ [${scenario.id}] ${contextLimit.toLocaleString()} tokens — ${scenario.label}`
  );

  let finalResult: Awaited<ReturnType<typeof spawnRun>> | null = null;
  let finalMetrics: MetricEvent[] = [];
  let completed = false;
  let failureClass = "unknown_incomplete";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_CELL; attempt += 1) {
    const result = await spawnRun(
      scenario.prompt,
      contextLimit,
      scenario.id,
      attempt
    );
    const trajEvents = result.stdout
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => tryParseJson<Record<string, unknown>>(line))
      .filter(Boolean) as Record<string, unknown>[];
    const outcome = classifyOutcome({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      trajEvents,
    });

    finalResult = result;
    finalMetrics = parseMetrics(`${result.stdout}\n${result.stderr}`);
    completed = outcome.completed;
    failureClass = outcome.failureClass;

    if (completed) {
      break;
    }

    if (
      attempt < MAX_ATTEMPTS_PER_CELL &&
      ["no_output", "no_assistant", "terminated", "error_event"].includes(
        failureClass
      )
    ) {
      await sleepMs(RETRY_COOLDOWN_MS);
      continue;
    }

    break;
  }

  if (!finalResult) {
    throw new Error(`No benchmark result for ${scenario.id}-${contextLimit}`);
  }

  writeFileSync(outputLogPath, finalResult.stdout, "utf-8");
  writeFileSync(metricsPath, finalResult.stderr, "utf-8");

  const compactionCount = finalMetrics.filter(
    (event) => event.event === "compaction_complete" && event.success !== false
  ).length;
  const blockingCount = finalMetrics.filter(
    (event) => event.event === "blocking_start"
  ).length;
  const turnCompletes = finalMetrics.filter(
    (event) => event.event === "turn_complete"
  );
  const maxTokensUsed = turnCompletes.reduce(
    (max, event) =>
      Math.max(max, event.actualTokens ?? event.estimatedTokens ?? 0),
    0
  );
  const probeMax = finalMetrics
    .filter((event) => event.event === "usage_probe")
    .reduce((max, event) => Math.max(max, event.promptTokens ?? 0), 0);

  console.log(
    `  ✓ compactions=${compactionCount}, blocking=${blockingCount}, maxTokens=${maxTokensUsed}, probeMax=${probeMax}, turns=${turnCompletes.length}, completed=${completed ? "yes" : "no"}, failure=${failureClass}, ${formatDuration(finalResult.durationMs)}`
  );

  return {
    promptId: scenario.id,
    contextLimit,
    compactionCount,
    blockingCount,
    maxTokensUsed,
    failureClass,
    probeMax,
    turnCount: turnCompletes.length,
    completed,
    durationMs: finalResult.durationMs,
    exitCode: finalResult.exitCode,
    timedOut: finalResult.timedOut,
    outputLogPath,
    metricsPath,
  };
}

async function runParallelWithLimit(tasks: PendingRun[]): Promise<RunResult[]> {
  const results: RunResult[] = new Array(tasks.length);
  let nextIndex = 0;
  const effectiveParallelLimit = resolveParallelLimit(tasks.length);

  async function worker(workerIndex: number): Promise<void> {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const task = tasks[currentIndex];
      if (!task) {
        return;
      }

      const waitMs = workerIndex === 0 && currentIndex === 0 ? 0 : staggerMs;
      if (waitMs > 0) {
        await sleepMs(waitMs);
      }

      try {
        results[currentIndex] = await runOne(task.scenario, task.contextLimit);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(
          `  ✗ ${task.scenario.id}-${task.contextLimit} failed: ${msg}`
        );
        results[currentIndex] = {
          promptId: task.scenario.id,
          contextLimit: task.contextLimit,
          compactionCount: 0,
          blockingCount: 0,
          maxTokensUsed: 0,
          failureClass: "spawn_failure",
          probeMax: 0,
          turnCount: 0,
          completed: false,
          durationMs: 0,
          exitCode: null,
          timedOut: false,
          outputLogPath: "",
          metricsPath: "",
        };
      }
    }
  }

  const workerCount = Math.max(
    1,
    Math.min(effectiveParallelLimit, tasks.length)
  );
  await Promise.all(
    Array.from({ length: workerCount }, (_, index) => worker(index))
  );

  return results;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: benchmark reporting function
function buildSummary(
  results: RunResult[],
  totalMs: number,
  scenarios: PromptScenario[]
): string {
  const lines: string[] = [
    "═══════════════════════════════════════════════════════════════════",
    "  Multi-Prompt Compaction Benchmark Summary",
    `  Generated: ${new Date().toISOString()}`,
    `  Context limits: ${CONTEXT_LIMITS.join(", ")}`,
    `  Max iterations: ${MAX_ITERATIONS}`,
    `  Total run time: ${formatDuration(totalMs)}`,
    "═══════════════════════════════════════════════════════════════════",
    "",
  ];

  // Per-scenario table
  for (const sc of scenarios) {
    const scResults = results.filter((r) => r.promptId === sc.id);
    if (scResults.length === 0) {
      continue;
    }

    lines.push(`┌─ ${sc.id}: ${sc.label} (${sc.pattern})`);
    lines.push(
      `│  Prompt: ${sc.prompt.slice(0, 80)}${sc.prompt.length > 80 ? "..." : ""}`
    );
    lines.push("│");
    lines.push(
      "│  limit   │ compact │ block │ maxTok │ probeMax │ turns │ done │ time"
    );
    lines.push(
      "│  ────────┼─────────┼───────┼────────┼──────────┼───────┼──────┼──────"
    );

    for (const r of scResults) {
      lines.push(
        `│  ${String(r.contextLimit).padEnd(7)} │ ${String(r.compactionCount).padStart(7)} │ ${String(r.blockingCount).padStart(5)} │ ${String(r.maxTokensUsed).padStart(6)} │ ${String(r.probeMax).padStart(8)} │ ${String(r.turnCount).padStart(5)} │ ${(r.completed ? " yes" : "  no").padStart(4)} │ ${formatDuration(r.durationMs)}`
      );
    }
    lines.push(
      "└──────────────────────────────────────────────────────────────"
    );
    lines.push("");
  }

  // Cross-scenario comparison matrix
  lines.push("═══ Cross-Scenario Matrix: Compaction Count ═══");
  lines.push("");
  const header = [
    "scenario".padEnd(20),
    ...CONTEXT_LIMITS.map((l) => String(l).padStart(8)),
  ];
  lines.push(header.join(" │ "));
  lines.push("─".repeat(header.join(" │ ").length));

  for (const sc of scenarios) {
    const row = [sc.id.padEnd(20)];
    for (const limit of CONTEXT_LIMITS) {
      const r = results.find(
        (r) => r.promptId === sc.id && r.contextLimit === limit
      );
      row.push(r ? String(r.compactionCount).padStart(8) : "    -   ");
    }
    lines.push(row.join(" │ "));
  }

  lines.push("");
  lines.push("═══ Cross-Scenario Matrix: Blocking Count ═══");
  lines.push("");
  lines.push(header.join(" │ "));
  lines.push("─".repeat(header.join(" │ ").length));

  for (const sc of scenarios) {
    const row = [sc.id.padEnd(20)];
    for (const limit of CONTEXT_LIMITS) {
      const r = results.find(
        (r) => r.promptId === sc.id && r.contextLimit === limit
      );
      row.push(r ? String(r.blockingCount).padStart(8) : "    -   ");
    }
    lines.push(row.join(" │ "));
  }

  lines.push("");
  lines.push("═══ Cross-Scenario Matrix: Completed ═══");
  lines.push("");
  lines.push(header.join(" │ "));
  lines.push("─".repeat(header.join(" │ ").length));

  for (const sc of scenarios) {
    const row = [sc.id.padEnd(20)];
    for (const limit of CONTEXT_LIMITS) {
      const r = results.find(
        (r) => r.promptId === sc.id && r.contextLimit === limit
      );
      if (r) {
        row.push(r.completed ? "     yes" : "      no");
      } else {
        row.push("    -   ");
      }
    }
    lines.push(row.join(" │ "));
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI entry point
async function main(): Promise<void> {
  const selectedScenarioIds = scenarioFilter ?? [];
  const baseScenarios = scenarioFilter
    ? SCENARIOS.filter((s) => selectedScenarioIds.includes(s.id))
    : SCENARIOS;
  const priorityMap = new Map(
    SCENARIO_PRIORITY.map((id, index) => [id, index])
  );
  const activeScenarios = [...baseScenarios].sort((a, b) => {
    const left = priorityMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const right = priorityMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });

  console.log("\n🧪 Multi-Prompt Compaction Benchmark\n");
  console.log(`Scenarios: ${activeScenarios.map((s) => s.id).join(", ")}`);
  console.log(`Limits: ${CONTEXT_LIMITS.join(", ")}`);
  console.log(`Total runs: ${activeScenarios.length * CONTEXT_LIMITS.length}`);
  console.log(`Results: ${RESULTS_DIR}`);

  if (isDryRun) {
    console.log("\n🔍 Dry run:\n");
    for (const sc of activeScenarios) {
      for (const limit of CONTEXT_LIMITS) {
        console.log(`  ${sc.id}-${limit}: "${sc.prompt.slice(0, 60)}..."`);
      }
    }
    console.log("\n✅ Dry run complete.");
    return;
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const startedAt = Date.now();
  const isParallel = args.includes("--parallel");
  let results: RunResult[];

  if (isParallel) {
    const allTasks = activeScenarios.flatMap((scenario) =>
      CONTEXT_LIMITS.map((contextLimit) => ({ scenario, contextLimit }))
    );
    const effectiveParallelLimit = resolveParallelLimit(allTasks.length);
    console.log(
      `⚡ Parallel mode: ${activeScenarios.length} scenarios × ${CONTEXT_LIMITS.length} limits (limit=${effectiveParallelLimit}, stagger=${staggerMs}ms)\n`
    );
    results = await runParallelWithLimit(allTasks);
  } else {
    results = [];
    for (const sc of activeScenarios) {
      for (const limit of CONTEXT_LIMITS) {
        try {
          results.push(await runOne(sc, limit));
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`  ✗ ${sc.id}-${limit} failed: ${msg}`);
          results.push({
            promptId: sc.id,
            contextLimit: limit,
            compactionCount: 0,
            blockingCount: 0,
            maxTokensUsed: 0,
            failureClass: "spawn_failure",
            probeMax: 0,
            turnCount: 0,
            completed: false,
            durationMs: 0,
            exitCode: null,
            timedOut: false,
            outputLogPath: "",
            metricsPath: "",
          });
        }
      }
    }
  }

  const totalMs = Date.now() - startedAt;
  const summaryPath = resolvePath(RESULTS_DIR, "multi-prompt-summary.txt");
  const summary = buildSummary(results, totalMs, activeScenarios);
  writeFileSync(summaryPath, summary, "utf-8");

  console.log(`\n${summary}`);
  console.log(`✅ Summary: ${summaryPath}`);
  console.log(`Total: ${formatDuration(totalMs)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
