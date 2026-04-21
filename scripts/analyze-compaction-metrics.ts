#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolvePath(SCRIPT_DIR, "..", "results");
const EVIDENCE_DIR = resolvePath(SCRIPT_DIR, "..", ".sisyphus", "evidence");

const args = process.argv.slice(2);
const isSample = args.includes("--sample");
const outputPath = (() => {
  const idx = args.indexOf("--output");
  const defaultOutputPath = resolvePath(
    EVIDENCE_DIR,
    "compaction-e2e-report.md"
  );
  if (idx === -1) {
    return defaultOutputPath;
  }
  const value = args[idx + 1];
  return value && !value.startsWith("--") ? value : defaultOutputPath;
})();
interface BaseMetric {
  event: string;
  ts: number;
  turn: number;
}

interface TurnCompleteMetric extends BaseMetric {
  actualTokens: number | null;
  contextLimit: number;
  estimatedTokens: number;
  event: "turn_complete";
  source: "actual" | "estimated";
}

interface CompactionCompleteMetric extends BaseMetric {
  event: "compaction_complete";
  strategy?: string;
  success: boolean;
  tokensAfter: number;
  tokensBefore: number;
}

interface BlockingEndMetric extends BaseMetric {
  durationMs: number | null;
  event: "blocking_end";
}

type MetricEvent =
  | TurnCompleteMetric
  | CompactionCompleteMetric
  | BlockingEndMetric
  | BaseMetric;

function parseMetricsLog(content: string): MetricEvent[] {
  const events: MetricEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[compaction-metric]")) {
      continue;
    }
    const jsonStr = trimmed.slice("[compaction-metric]".length).trim();
    try {
      events.push(JSON.parse(jsonStr) as MetricEvent);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}
interface TurnData {
  actualTokens: number | null;
  blockingMs: number | null;
  compactionStrategy: string | null;
  contextLimit: number | null;
  estimatedTokens: number | null;
  hasCompaction: boolean;
  source: string | null;
  tokensAfter: number | null;
  tokensBefore: number | null;
  turn: number;
}

function aggregateByTurn(events: MetricEvent[]): TurnData[] {
  const byTurn = new Map<number, TurnData>();

  const get = (turn: number): TurnData => {
    if (!byTurn.has(turn)) {
      byTurn.set(turn, {
        turn,
        estimatedTokens: null,
        actualTokens: null,
        contextLimit: null,
        source: null,
        hasCompaction: false,
        compactionStrategy: null,
        tokensBefore: null,
        tokensAfter: null,
        blockingMs: null,
      });
    }
    const data = byTurn.get(turn);
    if (!data) {
      throw new Error(`Failed to retrieve turn data for turn ${turn}`);
    }
    return data;
  };

  for (const event of events) {
    const d = get(event.turn);
    if (event.event === "turn_complete") {
      const e = event as TurnCompleteMetric;
      d.estimatedTokens = e.estimatedTokens;
      d.actualTokens = e.actualTokens;
      d.contextLimit = e.contextLimit;
      d.source = e.source;
    } else if (event.event === "compaction_complete") {
      const e = event as CompactionCompleteMetric;
      d.hasCompaction = true;
      d.compactionStrategy = e.strategy ?? "unknown";
      d.tokensBefore = e.tokensBefore;
      d.tokensAfter = e.tokensAfter;
    } else if (event.event === "blocking_end") {
      const e = event as BlockingEndMetric;
      d.blockingMs = e.durationMs;
    }
  }

  return Array.from(byTurn.values()).sort((a, b) => a.turn - b.turn);
}

// ── Markdown table builder ─────────────────────────────────────
function fmt(n: number | null, suffix = ""): string {
  if (n == null) {
    return "—";
  }
  return `${n.toLocaleString()}${suffix}`;
}

function deltaPercent(estimated: number | null, actual: number | null): string {
  if (estimated == null || actual == null || estimated === 0) {
    return "—";
  }
  const pct = ((actual - estimated) / estimated) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

function buildScenarioTable(limit: number, turns: TurnData[]): string {
  const header = `## ${(limit / 1000).toFixed(0)}K Context Limit (${limit.toLocaleString()} tokens)\n`;

  if (turns.length === 0) {
    return `${header}\n*No turn_complete events found in metrics.*\n`;
  }

  const rows: string[] = [];
  rows.push(
    "| Turn | Estimated | Actual | Delta% | Source | Compaction? | Strategy | Blocking (ms) | Tokens After |"
  );
  rows.push(
    "|------|-----------|--------|--------|--------|-------------|----------|---------------|--------------|"
  );

  for (const t of turns) {
    const compaction = t.hasCompaction ? "✓ YES" : "No";
    const strategy = t.compactionStrategy ?? "—";
    const blocking = t.blockingMs == null ? "—" : `${t.blockingMs}`;
    const tokensAfter = t.hasCompaction ? fmt(t.tokensAfter) : "—";

    rows.push(
      `| ${t.turn} | ${fmt(t.estimatedTokens)} | ${fmt(t.actualTokens)} | ${deltaPercent(t.estimatedTokens, t.actualTokens)} | ${t.source ?? "—"} | ${compaction} | ${strategy} | ${blocking} | ${tokensAfter} |`
    );
  }

  // Summary stats
  const compactionTurns = turns.filter((t) => t.hasCompaction);
  const blockingTurns = turns.filter((t) => t.blockingMs != null);
  const avgDelta = (() => {
    const valid = turns.filter(
      (t) => t.estimatedTokens !== null && t.actualTokens !== null
    );
    if (valid.length === 0) {
      return "—";
    }
    const avg =
      valid.reduce((sum, t) => {
        const est = t.estimatedTokens;
        const act = t.actualTokens;
        if (!(est && act)) {
          return sum;
        }
        const pct = ((act - est) / est) * 100;
        return sum + pct;
      }, 0) / valid.length;
    const sign = avg >= 0 ? "+" : "";
    return `${sign}${avg.toFixed(1)}%`;
  })();

  const summary = [
    "",
    "**Summary:**",
    `- Total turns: ${turns.length}`,
    `- Compaction events: ${compactionTurns.length}`,
    `- Blocking events: ${blockingTurns.length}`,
    `- Total blocking time: ${blockingTurns.reduce((sum, t) => sum + (t.blockingMs ?? 0), 0)}ms`,
    `- Avg estimated→actual delta: ${avgDelta}`,
    `- First compaction: Turn ${compactionTurns[0]?.turn ?? "never"}`,
  ].join("\n");

  return `${header}\n${rows.join("\n")}\n${summary}`;
}

// ── Sample data for testing ───────────────────────────────────
const SAMPLE_LOG = `
[compaction-metric] {"ts":1000000,"event":"turn_complete","turn":1,"estimatedTokens":1200,"actualTokens":1850,"contextLimit":20000,"source":"actual"}
[compaction-metric] {"ts":1001000,"event":"turn_complete","turn":2,"estimatedTokens":5400,"actualTokens":8100,"contextLimit":20000,"source":"actual"}
[compaction-metric] {"ts":1002000,"event":"turn_complete","turn":3,"estimatedTokens":12300,"actualTokens":18500,"contextLimit":20000,"source":"actual"}
[compaction-metric] {"ts":1003000,"event":"compaction_start","turn":4}
[compaction-metric] {"ts":1003100,"event":"blocking_start","turn":4}
[compaction-metric] {"ts":1004500,"event":"compaction_complete","turn":4,"success":true,"strategy":"compact","tokensBefore":22400,"tokensAfter":4800}
[compaction-metric] {"ts":1004500,"event":"blocking_end","turn":4,"durationMs":1487}
[compaction-metric] {"ts":1004600,"event":"turn_complete","turn":4,"estimatedTokens":4800,"actualTokens":4800,"contextLimit":20000,"source":"actual"}
`;

// ── Main ──────────────────────────────────────────────────────
const main = () => {
  console.log("\n📊 Compaction Metrics Analyzer\n");

  const reportParts: string[] = [];
  reportParts.push("# Compaction E2E Test Results\n");
  reportParts.push(`Generated: ${new Date().toISOString()}\n`);

  const LIMITS = [8000, 20_000, 40_000];

  if (isSample) {
    console.log("🧪 Running with sample data...\n");
    const events = parseMetricsLog(SAMPLE_LOG);
    const turns = aggregateByTurn(events);
    const table = buildScenarioTable(20_000, turns);
    console.log(table);
    console.log("\n✅ Sample data test complete");
    return;
  }

  for (const limit of LIMITS) {
    const logPath = resolvePath(RESULTS_DIR, `${limit}-metrics.log`);
    if (!existsSync(logPath)) {
      console.log(`⚠ No metrics file for ${limit}: ${logPath}`);
      reportParts.push(
        `\n## ${(limit / 1000).toFixed(0)}K Context Limit\n\n*No results file found. Run the test first.*\n`
      );
      continue;
    }

    console.log(`📂 Reading ${limit.toLocaleString()} metrics from ${logPath}`);
    const content = readFileSync(logPath, "utf-8");
    const events = parseMetricsLog(content);
    const turns = aggregateByTurn(events);
    console.log(
      `   Found ${events.length} metric events, ${turns.length} turns`
    );

    const table = buildScenarioTable(limit, turns);
    reportParts.push(`\n${table}\n`);
  }

  const report = reportParts.join("\n");

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(outputPath, report, "utf-8");
  console.log(`\n✅ Report saved: ${outputPath}`);
  console.log(`\n${report}`);
};

main();
