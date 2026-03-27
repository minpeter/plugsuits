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
const SCENARIO_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ITERATIONS = 12;

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
      "packages/harness/src/compaction-orchestrator.ts 에서 blockAtHardLimit이 호출되는 전체 흐름을 추적해줘. 어디서 호출되고, 어떤 조건에서 blocking이 발생하고, compaction이 실패하면 어떻게 되는지 상세하게 분석해줘.",
    pattern: "read-heavy",
  },
  {
    id: "multi-file-refactor",
    label: "Multi-file analysis (cross-module)",
    prompt:
      "packages/harness/src/index.ts에서 export되는 모든 public API를 분석해줘. 각 export가 어떤 파일에서 오는지, 어떤 타입인지 (function/class/type/const), 그리고 packages/cea, packages/headless, packages/tui 중 어디서 사용되는지 매핑해줘.",
    pattern: "multi-step",
  },
  {
    id: "write-heavy",
    label: "Code generation (write-heavy)",
    prompt:
      "packages/harness/src/compaction-types.ts를 읽고, 모든 인터페이스와 타입에 대한 단위 테스트 파일 packages/harness/src/compaction-types.test.ts를 새로 작성해줘. 각 필드의 기본값, optional 여부, 타입 호환성을 테스트해야 해.",
    pattern: "write-heavy",
  },
];

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

const extraArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (["--dry-run", "--limits", "--scenarios", "--parallel"].includes(arg)) {
    if (!["--dry-run", "--parallel"].includes(arg)) {
      i++;
    }
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
  maxTokensUsed: number;
  metricsPath: string;
  probeMax: number;
  promptId: string;
  timedOut: boolean;
  trajectoryPath: string;
  turnCount: number;
}

// ─── Helpers ────────────────────────────────────────────────────────
function tryParseJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
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

// ─── Spawn ──────────────────────────────────────────────────────────
async function spawnRun(
  prompt: string,
  contextLimit: number
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
  const trajectoryPath = resolvePath(RESULTS_DIR, `${tag}-trajectory.jsonl`);
  const metricsPath = resolvePath(RESULTS_DIR, `${tag}-metrics.log`);

  console.log(
    `\n▶ [${scenario.id}] ${contextLimit.toLocaleString()} tokens — ${scenario.label}`
  );

  const result = await spawnRun(scenario.prompt, contextLimit);
  writeFileSync(trajectoryPath, result.stdout, "utf-8");
  writeFileSync(metricsPath, result.stderr, "utf-8");

  const metrics = parseMetrics(`${result.stdout}\n${result.stderr}`);
  const compactionCount = metrics.filter(
    (e) => e.event === "compaction_complete" && e.success !== false
  ).length;
  const blockingCount = metrics.filter(
    (e) => e.event === "blocking_start"
  ).length;
  const turnCompletes = metrics.filter((e) => e.event === "turn_complete");
  const maxTokensUsed = turnCompletes.reduce(
    (max, e) => Math.max(max, e.actualTokens ?? e.estimatedTokens ?? 0),
    0
  );
  const probeMax = metrics
    .filter((e) => e.event === "usage_probe")
    .reduce((max, e) => Math.max(max, e.promptTokens ?? 0), 0);

  // Check completion
  const trajEvents = result.stdout
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => tryParseJson<Record<string, unknown>>(l))
    .filter(Boolean) as Record<string, unknown>[];
  const hasError = trajEvents.some((e) => e.type === "error");
  const hasAssistant = trajEvents.some((e) => e.type === "assistant");
  const completed =
    !result.timedOut && result.exitCode === 0 && !hasError && hasAssistant;

  console.log(
    `  ✓ compactions=${compactionCount}, blocking=${blockingCount}, maxTokens=${maxTokensUsed}, probeMax=${probeMax}, turns=${turnCompletes.length}, completed=${completed ? "yes" : "no"}, ${formatDuration(result.durationMs)}`
  );

  return {
    promptId: scenario.id,
    contextLimit,
    compactionCount,
    blockingCount,
    maxTokensUsed,
    probeMax,
    turnCount: turnCompletes.length,
    completed,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    trajectoryPath,
    metricsPath,
  };
}

// ─── Summary ────────────────────────────────────────────────────────
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
      row.push(r ? (r.completed ? "     yes" : "      no") : "    -   ");
    }
    lines.push(row.join(" │ "));
  }

  lines.push("");
  return lines.join("\n") + "\n";
}

// ─── Main ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const activeScenarios = scenarioFilter
    ? SCENARIOS.filter((s) => scenarioFilter!.includes(s.id))
    : SCENARIOS;

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
    console.log(
      `⚡ Parallel mode: ${activeScenarios.length} scenarios × ${CONTEXT_LIMITS.length} limits\n`
    );
    const allTasks = activeScenarios.flatMap((sc) =>
      CONTEXT_LIMITS.map((limit) => ({ sc, limit }))
    );
    const settled = await Promise.allSettled(
      allTasks.map(({ sc, limit }) => runOne(sc, limit))
    );
    results = settled.map((s, i) => {
      if (s.status === "fulfilled") {
        return s.value;
      }
      const { sc, limit } = allTasks[i];
      console.error(`  ✗ ${sc.id}-${limit} failed: ${s.reason}`);
      return {
        promptId: sc.id,
        contextLimit: limit,
        compactionCount: 0,
        blockingCount: 0,
        maxTokensUsed: 0,
        probeMax: 0,
        turnCount: 0,
        completed: false,
        durationMs: 0,
        exitCode: null,
        timedOut: false,
        trajectoryPath: "",
        metricsPath: "",
      };
    });
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
            probeMax: 0,
            turnCount: 0,
            completed: false,
            durationMs: 0,
            exitCode: null,
            timedOut: false,
            trajectoryPath: "",
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
