#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolvePath(SCRIPT_DIR, "..", "results");
const GRAPHS_DIR = resolvePath(RESULTS_DIR, "compaction-graphs");
const COMPACTION_METRIC_PREFIX = "[compaction-metric]";
const LIMIT_REGEX = /(\d+)-metrics\.log$/u;

interface MetricEvent {
  actualTokens?: number | null;
  contextLimit?: number;
  durationMs?: number | null;
  event: string;
  success?: boolean;
  tokensAfter?: number;
  tokensBefore?: number;
  ts?: number;
  turn: number;
}

interface TurnData {
  actualTokens: number | null;
  contextLimit: number | null;
  hasBlocking: boolean;
  hasCompaction: boolean;
  turn: number;
}

interface GraphDimensions {
  graphHeight: number;
  graphWidth: number;
  maxTokens: number;
  minTokens: number;
  tokenHeight: number;
}

function parseMetricsLog(content: string): MetricEvent[] {
  const events: MetricEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(COMPACTION_METRIC_PREFIX)) {
      continue;
    }
    const jsonStr = trimmed.slice(COMPACTION_METRIC_PREFIX.length).trim();
    try {
      const parsed = JSON.parse(jsonStr) as MetricEvent;
      events.push(parsed);
    } catch (error) {
      const _unused = error;
    }
  }
  return events;
}

function aggregateTurns(events: MetricEvent[]): TurnData[] {
  const byTurn = new Map<number, TurnData>();

  const get = (turn: number): TurnData => {
    if (!byTurn.has(turn)) {
      byTurn.set(turn, {
        turn,
        actualTokens: null,
        contextLimit: null,
        hasCompaction: false,
        hasBlocking: false,
      });
    }
    const result = byTurn.get(turn);
    if (!result) {
      throw new Error(`Failed to retrieve turn data for turn ${turn}`);
    }
    return result;
  };

  for (const event of events) {
    const d = get(event.turn);
    switch (event.event) {
      case "turn_complete": {
        d.actualTokens = event.actualTokens ?? null;
        d.contextLimit = event.contextLimit ?? null;
        break;
      }
      case "compaction_complete": {
        d.hasCompaction = true;
        break;
      }
      case "blocking_start": {
        d.hasBlocking = true;
        break;
      }
      default: {
        break;
      }
    }
  }

  return Array.from(byTurn.values()).sort((a, b) => a.turn - b.turn);
}

function getGraphDimensions(turns: TurnData[]): GraphDimensions {
  const contextLimits: number[] = [];
  for (const t of turns) {
    if (t.contextLimit !== null) {
      contextLimits.push(t.contextLimit);
    }
  }

  const maxTokens =
    contextLimits.length > 0 ? Math.max(...contextLimits) : 20_000;

  const graphHeight = Math.max(10, Math.min(30, Math.ceil(maxTokens / 2000)));
  const graphWidth = Math.max(40, Math.min(120, turns.length * 3 + 10));

  return {
    graphHeight,
    graphWidth,
    minTokens: 0,
    maxTokens,
    tokenHeight: maxTokens / graphHeight,
  };
}

function getMarker(turn: TurnData): string {
  if (turn.hasCompaction && turn.hasBlocking) {
    return "X";
  }
  if (turn.hasCompaction) {
    return "|";
  }
  if (turn.hasBlocking) {
    return "!";
  }
  return "▓";
}

function buildGridFromTurns(
  turns: TurnData[],
  contextLimit: number,
  graphHeight: number,
  graphWidth: number
): (string | undefined)[][] {
  const grid: (string | undefined)[][] = Array.from(
    { length: graphHeight + 1 },
    () => new Array(graphWidth)
  );

  for (let row = 0; row <= graphHeight; row++) {
    for (let col = 0; col < graphWidth; col++) {
      grid[row][col] = " ";
    }
  }

  for (let col = 0; col < graphWidth; col++) {
    grid[0][col] = "─";
  }

  for (let i = 0; i < turns.length && i < graphWidth - 2; i++) {
    const turn = turns[i];
    if (turn.actualTokens === null) {
      continue;
    }

    const col = 2 + Math.floor((i / turns.length) * (graphWidth - 4));
    const tokenPercent = turn.actualTokens / contextLimit;
    const row = graphHeight - Math.floor(tokenPercent * graphHeight);

    if (row >= 0 && row <= graphHeight) {
      grid[row][col] = getMarker(turn);
    }
  }

  return grid;
}

function renderAsciiGraph(turns: TurnData[], contextLimit: number): string {
  if (turns.length === 0) {
    return "No turn_complete events found.";
  }

  const dims = getGraphDimensions(turns);
  const { graphHeight, graphWidth, tokenHeight } = dims;

  const grid = buildGridFromTurns(turns, contextLimit, graphHeight, graphWidth);

  const lines: string[] = [];

  const limitKb = (contextLimit / 1000).toFixed(0);
  const compactionCount = turns.filter((t) => t.hasCompaction).length;
  const blockingCount = turns.filter((t) => t.hasBlocking).length;
  lines.push(
    `Scenario: ${limitKb}K context limit | ${turns.length} turns | ${compactionCount} compactions | ${blockingCount} blocking`
  );
  lines.push("═".repeat(Math.min(80, graphWidth)));

  for (let row = 0; row <= graphHeight; row++) {
    let line = "";

    if (row === 0) {
      const label = `${contextLimit.toLocaleString()}`;
      line = label.padEnd(8);
    } else if (row === graphHeight) {
      line = "0       ";
    } else {
      const tokenValue = Math.round((graphHeight - row) * tokenHeight);
      const label = `${tokenValue.toLocaleString()}`.slice(0, 7);
      line = label.padEnd(8);
    }

    const rowContent = grid[row]
      .map((c) => c || " ")
      .join("")
      .trimEnd();
    line += rowContent;
    lines.push(line);
  }

  lines.push("");
  lines.push("Legend:");
  lines.push("  ▓ = actual token count at turn");
  lines.push("  | = compaction event");
  lines.push("  ! = blocking event");
  lines.push("  X = both compaction and blocking");
  lines.push("  ─ = context limit line");

  return lines.join("\n");
}

function main() {
  console.log("\n📊 Compaction Token Usage Graph Generator\n");

  const args = process.argv.slice(2);
  let logFiles: string[] = [];

  if (args.length > 0) {
    const logPath = resolvePath(args[0]);
    if (!existsSync(logPath)) {
      console.error(`❌ Metrics file not found: ${logPath}`);
      process.exit(1);
    }
    logFiles = [logPath];
  } else {
    const limits = [8000, 20_000, 40_000, 80_000];
    for (const limit of limits) {
      const logPath = resolvePath(RESULTS_DIR, `${limit}-metrics.log`);
      if (existsSync(logPath)) {
        logFiles.push(logPath);
      }
    }

    if (logFiles.length === 0) {
      console.log(
        "⚠️  No metrics files found. Looking for: 8000-metrics.log, 20000-metrics.log, etc."
      );
      console.log(
        "   Run the benchmark first: node --import tsx scripts/compaction-benchmark.ts"
      );
      return;
    }
  }

  mkdirSync(GRAPHS_DIR, { recursive: true });

  for (const logPath of logFiles) {
    console.log(`📊 Processing: ${logPath}`);

    const content = readFileSync(logPath, "utf-8");
    const events = parseMetricsLog(content);
    const turns = aggregateTurns(events);

    if (turns.length === 0) {
      console.log("   ⚠️  No turn_complete events found");
      continue;
    }

    const contextLimit = turns[0].contextLimit;
    if (contextLimit === null) {
      console.log("   ⚠️  No context limit found in metrics");
      continue;
    }

    const graph = renderAsciiGraph(turns, contextLimit);

    const match = logPath.match(LIMIT_REGEX);
    const limitStr = match ? match[1] : "unknown";
    const outputPath = resolvePath(GRAPHS_DIR, `scenario-${limitStr}.txt`);

    writeFileSync(outputPath, graph, "utf-8");
    console.log(`   ✅ Graph saved: ${outputPath}`);
    console.log("");
    console.log(graph);
    console.log("");
  }

  console.log(`\n✅ Graphs generated in: ${GRAPHS_DIR}`);
}

main();
