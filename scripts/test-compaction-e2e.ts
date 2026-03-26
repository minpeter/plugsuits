#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HEADLESS_SCRIPT = resolvePath(
  SCRIPT_DIR,
  "..",
  "packages",
  "cea",
  "src",
  "entrypoints",
  "main.ts"
);
const RESULTS_DIR = resolvePath(SCRIPT_DIR, "..", "results");

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const extraArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (
    (arg === "-m" || arg === "--model" || arg === "--provider") &&
    i + 1 < args.length
  ) {
    extraArgs.push(arg, args[i + 1]);
    i++;
  } else if (arg === "--no-translate") {
    extraArgs.push(arg);
  }
}

interface Scenario {
  contextLimit: number;
  maxIterations: number;
  prompt: string;
}

const buildPrompt = (filePaths: string[]): string => {
  const fileList = filePaths
    .map(
      (f, i) =>
        `${i + 1}. Read '${f}' and describe what it does in 2-3 sentences.`
    )
    .join(" ");
  return `Please do the following in sequence: ${fileList} Finally, summarize the overall architecture in one paragraph.`;
};

const LARGE_FILES = [
  "packages/harness/src/checkpoint-history.ts",
  "packages/harness/src/compaction-orchestrator.ts",
  "packages/tui/src/agent-tui.ts",
  "packages/cea/src/entrypoints/main.ts",
  "packages/harness/src/checkpoint-history.test.ts",
  "packages/headless/src/runner.ts",
  "packages/harness/src/compaction-policy.ts",
  "packages/harness/src/token-utils.ts",
  "packages/harness/src/loop.ts",
  "packages/harness/src/compaction-planner.ts",
];

const SCENARIOS: Scenario[] = [
  {
    contextLimit: 8000,
    maxIterations: 10,
    prompt: buildPrompt(LARGE_FILES.slice(0, 3)),
  },
  {
    contextLimit: 20_000,
    maxIterations: 20,
    prompt: buildPrompt(LARGE_FILES.slice(0, 6)),
  },
  {
    contextLimit: 40_000,
    maxIterations: 30,
    prompt: buildPrompt(LARGE_FILES),
  },
];

if (isDryRun) {
  console.log("\n🔍 Compaction E2E Test — DRY RUN\n");
  console.log("Results directory:", RESULTS_DIR);
  console.log("Headless script:", HEADLESS_SCRIPT);
  console.log();

  for (const scenario of SCENARIOS) {
    const reserve = Math.max(
      256,
      Math.floor(2000 * (scenario.contextLimit / 200_000))
    );
    const keepRecent = Math.floor(scenario.contextLimit * 0.3);
    console.log(
      `Scenario: contextLimit=${scenario.contextLimit.toLocaleString()}`
    );
    console.log(`  maxIterations: ${scenario.maxIterations}`);
    console.log(
      `  effectiveReserve: ~${reserve} (auto-scaled by CONTEXT_LIMIT_OVERRIDE)`
    );
    console.log(`  effectiveKeepRecent: ~${keepRecent} (30% of contextLimit)`);
    console.log(
      `  files to read: ${LARGE_FILES.filter((f) => scenario.prompt.includes(f)).length}`
    );
    console.log(`  prompt preview: "${scenario.prompt.slice(0, 120)}..."`);
    console.log();
  }

  console.log("Output files (will be created on real run):");
  for (const s of SCENARIOS) {
    console.log(`  results/${s.contextLimit}-trajectory.jsonl`);
    console.log(`  results/${s.contextLimit}-metrics.log`);
  }

  console.log("\n✅ Dry run complete — no API calls made");
  process.exit(0);
}

async function runScenario(scenario: Scenario): Promise<void> {
  const { contextLimit, maxIterations, prompt } = scenario;
  console.log(
    `\n▶ Running scenario: contextLimit=${contextLimit.toLocaleString()}, maxIterations=${maxIterations}`
  );

  const nodeArgs = [
    "--conditions=@ai-sdk-tool/source",
    "--import",
    "tsx",
    HEADLESS_SCRIPT,
    "-p",
    prompt,
    "--max-iterations",
    String(maxIterations),
    "--no-translate",
    ...extraArgs,
  ];

  const env = {
    ...process.env,
    COMPACTION_DEBUG: "1",
    CONTEXT_LIMIT_OVERRIDE: String(contextLimit),
  };

  const output = await new Promise<{ out: string; err: string }>(
    (resolveOutput, reject) => {
      const proc = spawn("node", nodeArgs, {
        cwd: resolvePath(SCRIPT_DIR, ".."),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let out = "";
      let err = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString();
      });

      const timeout = setTimeout(
        () => {
          proc.kill("SIGTERM");
          reject(
            new Error(`Scenario ${contextLimit} timed out after 10 minutes`)
          );
        },
        10 * 60 * 1000
      );

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0 && code !== null) {
          console.error(`  Exit code ${code}`);
        }
        resolveOutput({ out, err });
      });

      proc.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    }
  );

  writeFileSync(
    `${RESULTS_DIR}/${contextLimit}-trajectory.jsonl`,
    output.out,
    "utf-8"
  );
  writeFileSync(
    `${RESULTS_DIR}/${contextLimit}-metrics.log`,
    output.err,
    "utf-8"
  );

  const metricLines = output.err
    .split("\n")
    .filter((line) => line.startsWith("[compaction-metric]"));
  const compactionEvents = metricLines.filter((line) =>
    line.includes('"event":"compaction_complete"')
  );
  const blockingEvents = metricLines.filter((line) =>
    line.includes('"event":"blocking_start"')
  );

  console.log(
    `  ✓ Done — metrics: ${metricLines.length} lines, compactions: ${compactionEvents.length}, blocking: ${blockingEvents.length}`
  );
  console.log(
    `  Saved: results/${contextLimit}-trajectory.jsonl (${output.out.length} bytes)`
  );
  console.log(
    `  Saved: results/${contextLimit}-metrics.log (${output.err.length} bytes)`
  );
}

const main = async () => {
  console.log(
    "\n🧪 Compaction E2E Test — 8K/20K/40K Context Limit Verification\n"
  );

  mkdirSync(RESULTS_DIR, { recursive: true });
  console.log(`Results dir: ${RESULTS_DIR}`);

  for (const scenario of SCENARIOS) {
    try {
      await runScenario(scenario);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ Scenario ${scenario.contextLimit} failed: ${msg}`);
    }
  }

  console.log("\n✅ All scenarios complete");
  console.log("\nNext: Run analyzer with:");
  console.log("  npx tsx scripts/analyze-compaction-metrics.ts");
};

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
