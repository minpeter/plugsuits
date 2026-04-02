import { writeFileSync } from "node:fs";
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  CheckpointHistory,
  CompactionOrchestrator,
  createModelSummarizer,
  estimateTokens,
} from "@ai-sdk-tool/harness";
import { createFriendli } from "@friendliai/ai-provider";
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { defineCommand, runMain } from "citty";

const SYSTEM_PROMPT = `You are a minimal example agent. Be concise and helpful.
When the user shares personal information (name, preferences, pets, job, hobbies, etc.), remember it carefully.
When asked to recall information, list ALL known facts — do not omit any details.`;

const CHATBOT_COMPACTION_PROMPT = `[INTERNAL COMPACTION — NOT USER INPUT]
Summarize this conversation to preserve the user's identity and all shared facts.

## User Profile
Extract ALL personal details the user shared: name, job, location, pets, hobbies, preferences, favorites, family, routines, goals, and any other facts. Use bullet points. Omit nothing.

## Conversation Highlights
Summarize key topics discussed, questions asked, and advice given. Keep it brief but include any specific recommendations or decisions.

## Current Topic
What was the most recent topic of conversation? What would the user likely ask about next?

Respond with ONLY the <summary>...</summary> block.`;

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
} as const;

interface TurnDef {
  expected?: string[];
  message: string;
  type: "chat" | "fact" | "probe";
}

const TURNS: TurnDef[] = [
  // Block 1: Core identity (turns 1-4)
  {
    type: "fact",
    message: "Hello! My name is Alice and I love cooking Italian food.",
  },
  {
    type: "fact",
    message: "I have a golden retriever named Max. He is 3 years old.",
  },
  {
    type: "fact",
    message: "I work as a software engineer at a startup in San Francisco.",
  },
  {
    type: "fact",
    message:
      "My favorite programming language is Rust. I use it for systems programming.",
  },
  // Probe 1 (turn 5): tests turns 1
  {
    type: "probe",
    message:
      "Quick check — what is my name and what type of food do I love cooking?",
    expected: ["Alice", "Italian"],
  },

  // Block 2: Hobbies & preferences (turns 6-9)
  {
    type: "fact",
    message:
      "I enjoy hiking on weekends. Last Saturday I went to Mount Tamalpais.",
  },
  {
    type: "fact",
    message: "My all-time favorite book is Dune by Frank Herbert.",
  },
  {
    type: "fact",
    message: "My favorite color is blue and I love the autumn season.",
  },
  {
    type: "chat",
    message: "What are some good autumn Italian recipes you would recommend?",
  },
  // Probe 2 (turn 10): tests turns 2, 4
  {
    type: "probe",
    message:
      "Do you remember my dog's name and what programming language I use?",
    expected: ["Max", "Rust"],
  },

  // Block 3: Social & travel (turns 11-14)
  {
    type: "fact",
    message: "My best friend is named Bob. We met in college studying CS.",
  },
  {
    type: "fact",
    message: "I traveled to Japan last year and absolutely loved Kyoto.",
  },
  {
    type: "fact",
    message:
      "I have a secret tiramisu recipe from my grandmother. The key is fresh espresso.",
  },
  {
    type: "chat",
    message:
      "What would be a good fusion dish combining Italian and Japanese cuisine?",
  },
  // Probe 3 (turn 15): tests turns 3, 6
  {
    type: "probe",
    message:
      "Where do I live and what outdoor activity do I enjoy on weekends?",
    expected: ["San Francisco", "hiking"],
  },

  // Block 4: Daily life (turns 16-19)
  {
    type: "fact",
    message: "My favorite movie is Spirited Away by Miyazaki.",
  },
  {
    type: "fact",
    message: "I grow fresh basil on my apartment balcony for cooking.",
  },
  {
    type: "fact",
    message:
      "Every morning I run 5 kilometers before work, then cook breakfast.",
  },
  {
    type: "chat",
    message:
      "What is a quick healthy Italian breakfast I could make after a run?",
  },
  // Probe 4 (turn 20): tests turns 7, 8
  {
    type: "probe",
    message: "What is my favorite book and what is my favorite color?",
    expected: ["Dune", "blue"],
  },

  // Block 5: Aspirations (turns 21-24)
  {
    type: "fact",
    message: "My dream trip is visiting the Amalfi Coast in Italy.",
  },
  {
    type: "fact",
    message: "I go to the farmers market every Saturday morning.",
  },
  {
    type: "fact",
    message: "I cannot stand overcooked pasta. It must always be al dente.",
  },
  {
    type: "chat",
    message:
      "How do professional chefs ensure perfect al dente pasta every time?",
  },
  // Probe 5 (turn 25): comprehensive
  {
    type: "probe",
    message:
      "Please list everything you remember about me — my name, job, pets, hobbies, favorites, and any other details.",
    expected: ["Alice", "Italian", "Max", "Rust", "San Francisco", "hiking"],
  },

  // Block 6: Recent additions (turns 26-29)
  {
    type: "fact",
    message: "I grew up in Portland, Oregon before moving to SF.",
  },
  {
    type: "fact",
    message: "My sister Emma lives in New York. She is a graphic designer.",
  },
  {
    type: "fact",
    message: "Max knows two tricks: shake and roll over. He is very smart!",
  },
  {
    type: "chat",
    message:
      "I am thinking about building a recipe management app in Rust. Any architectural advice?",
  },
  // Probe 6 (turn 30): first + recent
  {
    type: "probe",
    message:
      "Final test: what was the very first thing I told you about myself, and what is my sister's name?",
    expected: ["Alice", "Italian", "Emma"],
  },

  // Block 7: Extended conversation (turns 31-34)
  {
    type: "fact",
    message:
      "I just adopted a cat named Luna. She is a black cat, about 2 years old.",
  },
  {
    type: "fact",
    message:
      "My favorite restaurant is called Trattoria Milano. They make amazing risotto.",
  },
  {
    type: "fact",
    message: "I am learning to play guitar. I started about 3 months ago.",
  },
  {
    type: "chat",
    message:
      "What are some easy Italian songs I could learn on guitar as a beginner?",
  },
  // Probe 7 (turn 35): test old + new facts after likely compaction
  {
    type: "probe",
    message:
      "What pets do I have? List all of them with their names and details.",
    expected: ["Max", "golden retriever", "Luna", "cat"],
  },

  // Block 8: More depth (turns 36-39)
  {
    type: "fact",
    message: "My birthday is March 15th. I am turning 30 this year.",
  },
  {
    type: "fact",
    message: "I recently got promoted to senior engineer at my startup.",
  },
  {
    type: "fact",
    message: "My partner's name is David. He works as a teacher.",
  },
  {
    type: "chat",
    message:
      "David and I want to cook a special Italian dinner for my birthday. What would you suggest for a 4-course menu?",
  },
  // Probe 8 (turn 40): cross-reference old and new facts
  {
    type: "probe",
    message:
      "Tell me about my family and relationships — who are the people in my life?",
    expected: ["Emma", "David", "sister", "partner"],
  },

  // Block 9: Lifestyle updates (turns 41-44)
  {
    type: "fact",
    message: "I switched from running 5k to training for a half marathon.",
  },
  {
    type: "fact",
    message:
      "I just finished reading Project Hail Mary by Andy Weir. Loved it even more than Dune.",
  },
  {
    type: "fact",
    message:
      "Luna and Max actually get along really well. They sleep together on the couch.",
  },
  {
    type: "chat",
    message:
      "Can you recommend some science fiction books similar to Project Hail Mary and Dune?",
  },
  // Probe 9 (turn 45): test deep memory after multiple compactions
  {
    type: "probe",
    message:
      "What is my name, where do I work, and what programming language do I use?",
    expected: ["Alice", "senior engineer", "Rust"],
  },

  // Block 10: Final stretch (turns 46-49)
  {
    type: "fact",
    message:
      "I am planning to visit the Amalfi Coast next summer with David for my birthday trip.",
  },
  {
    type: "fact",
    message:
      "I started a food blog where I share my grandmother's Italian recipes.",
  },
  {
    type: "fact",
    message:
      "Max just learned a new trick: he can now catch a frisbee mid-air!",
  },
  {
    type: "chat",
    message:
      "What are the must-visit spots on the Amalfi Coast for food lovers?",
  },
  // Probe 10 (turn 50): comprehensive final recall
  {
    type: "probe",
    message:
      "Give me a complete summary of everything you know about me — name, job, city, pets, family, hobbies, favorites, and goals.",
    expected: [
      "Alice",
      "Rust",
      "San Francisco",
      "Max",
      "Luna",
      "David",
      "Emma",
      "Italian",
      "hiking",
    ],
  },
];

interface TurnMetrics {
  assistantTokens: number;
  compactionEvent: string;
  contextAfter: number;
  contextBefore: number;
  probeDetails?: string;
  probeScore?: string;
  turn: number;
  type: string;
  userTokens: number;
}

async function callModel(
  model: LanguageModel,
  messages: ModelMessage[],
  maxRetries = 1
): Promise<{
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await generateText({
        model,
        system: SYSTEM_PROMPT,
        messages,
        maxOutputTokens: 300,
        temperature: 0,
      });
      return {
        text: result.text,
        usage: {
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        process.stderr.write(`  ${C.yellow}Retry (${msg})${C.reset}\n`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

function evaluateProbe(
  text: string,
  expected: string[]
): { details: string; score: string } {
  const lower = text.toLowerCase();
  const found = expected.filter((kw) => lower.includes(kw.toLowerCase()));
  const missed = expected.filter((kw) => !lower.includes(kw.toLowerCase()));

  const details = [
    ...found.map((k) => `${C.green}✓${k}${C.reset}`),
    ...missed.map((k) => `${C.red}✗${k}${C.reset}`),
  ].join(" ");

  return { score: `${found.length}/${expected.length}`, details };
}

function filledChar(i: number, specPos: number, blockPos: number): string {
  if (i >= blockPos) {
    return `${C.red}█${C.reset}`;
  }
  if (i >= specPos) {
    return `${C.yellow}█${C.reset}`;
  }
  return `${C.green}█${C.reset}`;
}

function emptyChar(i: number, specPos: number, blockPos: number): string {
  if (i === specPos) {
    return `${C.dim}┊${C.reset}`;
  }
  if (i === blockPos) {
    return `${C.dim}│${C.reset}`;
  }
  return " ";
}

function renderBar(
  tokens: number,
  contextLimit: number,
  specPos: number,
  blockPos: number,
  width: number
): string {
  const filled = Math.min(width, Math.round((tokens / contextLimit) * width));
  let bar = "";
  for (let i = 0; i < width; i++) {
    bar +=
      i < filled
        ? filledChar(i, specPos, blockPos)
        : emptyChar(i, specPos, blockPos);
  }
  return bar;
}

function tokenColor(
  tokens: number,
  blocking: number,
  speculative: number
): string {
  if (tokens > blocking) {
    return C.red;
  }
  if (tokens > speculative) {
    return C.yellow;
  }
  return C.green;
}

function scoreColor(found: number, total: number): string {
  if (found === total) {
    return C.green;
  }
  if (found > 0) {
    return C.yellow;
  }
  return C.red;
}

function pctColor(pct: number): string {
  if (pct >= 80) {
    return C.green;
  }
  if (pct >= 50) {
    return C.yellow;
  }
  return C.red;
}

function turnIcon(type: string): string {
  if (type === "probe") {
    return "🔍";
  }
  if (type === "fact") {
    return "📝";
  }
  return "💬";
}

function turnTypeChar(type: string): string {
  if (type === "probe") {
    return "?";
  }
  if (type === "fact") {
    return "·";
  }
  return " ";
}

function printResults(
  metrics: TurnMetrics[],
  contextLimit: number,
  blockingThreshold: number,
  speculativeThreshold: number
): void {
  const BAR_WIDTH = 50;
  const specPos = Math.round((speculativeThreshold / contextLimit) * BAR_WIDTH);
  const blockPos = Math.round((blockingThreshold / contextLimit) * BAR_WIDTH);

  console.log(`\n${C.bold}═══ Turn-by-Turn Metrics ═══${C.reset}\n`);
  console.log(
    `${C.dim}Context: ${contextLimit} │ Blocking: ${blockingThreshold} │ Speculative: ${speculativeThreshold}${C.reset}\n`
  );

  const colWidths = [4, 5, 4, 4, 6, 6, 22, 5];
  const headers = [
    "Turn",
    "Type",
    "In",
    "Out",
    "Before",
    "After",
    "Compaction",
    "Probe",
  ];
  const headerLine = headers
    .map((h, i) => (i < 2 ? h.padEnd(colWidths[i]) : h.padStart(colWidths[i])))
    .join(" │ ");
  const sep = colWidths.map((w) => "─".repeat(w)).join("─┼─");

  console.log(sep);
  console.log(headerLine);
  console.log(sep);

  for (const m of metrics) {
    const afterColor = tokenColor(
      m.contextAfter,
      blockingThreshold,
      speculativeThreshold
    );
    const row = [
      String(m.turn).padStart(4),
      m.type.padEnd(5),
      String(m.userTokens).padStart(4),
      String(m.assistantTokens).padStart(4),
      String(m.contextBefore).padStart(6),
      `${afterColor}${String(m.contextAfter).padStart(6)}${C.reset}`,
      (m.compactionEvent || "").padEnd(22),
      (m.probeScore || "").padEnd(5),
    ].join(" │ ");
    console.log(row);
  }
  console.log(sep);

  const probes = metrics.filter((m) => m.type === "probe");
  if (probes.length > 0) {
    console.log(`\n${C.bold}═══ Memory Probe Results ═══${C.reset}\n`);

    let totalFound = 0;
    let totalExpected = 0;

    for (const p of probes) {
      const turn = TURNS[p.turn - 1];
      const parts = (p.probeScore || "0/0").split("/").map(Number);
      totalFound += parts[0];
      totalExpected += parts[1];

      const probeColor = scoreColor(parts[0], parts[1]);
      console.log(
        `  Turn ${String(p.turn).padStart(2)}: ${probeColor}${p.probeScore}${C.reset}  ${p.probeDetails || ""}`
      );
      console.log(`  ${C.dim}  Q: ${turn.message}${C.reset}\n`);
    }

    const pct =
      totalExpected > 0 ? Math.round((totalFound / totalExpected) * 100) : 0;
    const overallColor = pctColor(pct);
    console.log(
      `  ${C.bold}Overall: ${overallColor}${totalFound}/${totalExpected} (${pct}%)${C.reset}`
    );
  }

  console.log(`\n${C.bold}═══ Context Usage Chart ═══${C.reset}\n`);
  console.log(
    `  ${C.dim}${" ".repeat(4)}${"─".repeat(specPos)}S${"─".repeat(blockPos - specPos - 1)}B${"─".repeat(BAR_WIDTH - blockPos - 1)}${C.reset}`
  );

  for (const m of metrics) {
    const bar = renderBar(
      m.contextAfter,
      contextLimit,
      specPos,
      blockPos,
      BAR_WIDTH
    );
    const label = m.compactionEvent ? ` ← ${m.compactionEvent}` : "";
    const typeIcon = turnTypeChar(m.type);
    console.log(
      `  ${String(m.turn).padStart(2)}${typeIcon}│${bar}│ ${m.contextAfter}${label}`
    );
  }
  console.log();
}

async function runBenchmark(opts: {
  baseline?: boolean;
  contextLimit: number;
  model: LanguageModel;
  modelId: string;
}) {
  const { contextLimit, model, modelId } = opts;

  const thresholdRatio = 0.65;
  const speculativeRatio = 0.8;
  const reserveTokens = 512;
  const keepRecentTokens = 800;
  const blockingThreshold = Math.floor(contextLimit * thresholdRatio);
  const speculativeThreshold = Math.floor(blockingThreshold * speculativeRatio);

  const summarizeFn = createModelSummarizer(model, {
    contextLimit,
    ...(opts.baseline ? {} : { prompt: CHATBOT_COMPACTION_PROMPT }),
  });

  const history = new CheckpointHistory({
    compaction: {
      enabled: true,
      contextLimit,
      keepRecentTokens,
      reserveTokens,
      thresholdRatio,
      speculativeStartRatio: speculativeRatio,
      summarizeFn,
    },
  });
  history.setContextLimit(contextLimit);
  history.setSystemPromptTokens(estimateTokens(SYSTEM_PROMPT));

  let compactionEvent = "";
  let speculativeStarted = false;

  const orchestrator = new CompactionOrchestrator(history, {
    onCompactionComplete: (result) => {
      if (result.success) {
        const saved = result.tokensBefore - result.tokensAfter;
        compactionEvent = `compacted (−${saved})`;
      }
    },
    onJobStatus: (_id, _msg, state) => {
      if (state === "running") {
        speculativeStarted = true;
      }
    },
    onApplied: (detail) => {
      if (detail.tokenDelta < 0) {
        compactionEvent = `spec applied (${detail.tokenDelta})`;
      }
    },
  });

  const metrics: TurnMetrics[] = [];

  process.stderr.write(`\n${C.bold}Compaction Benchmark${C.reset}\n`);
  process.stderr.write(
    `Model: ${modelId} | Context: ${contextLimit} | Blocking: ${blockingThreshold} | Speculative: ${speculativeThreshold}\n\n`
  );

  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i];
    const turnNum = i + 1;

    compactionEvent = "";
    speculativeStarted = false;

    const readyResult = orchestrator.applyReady();
    if (readyResult.applied) {
      compactionEvent = "spec applied";
    }

    await orchestrator.blockIfNeeded(turn.message);

    const contextBefore = history.getEstimatedTokens();

    history.addUserMessage(turn.message);

    const userTokens = estimateTokens(turn.message);

    const result = await callModel(model, history.getMessagesForLLM());

    history.addModelMessages([
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: result.text }],
      },
    ]);
    history.updateActualUsage({
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });

    orchestrator.startSpeculative();
    if (speculativeStarted && !compactionEvent) {
      compactionEvent = "spec started";
    }
    await orchestrator.checkAndCompact();

    const contextAfter = history.getEstimatedTokens();

    let probeScore: string | undefined;
    let probeDetails: string | undefined;
    if (turn.type === "probe" && turn.expected) {
      const evaluation = evaluateProbe(result.text, turn.expected);
      probeScore = evaluation.score;
      probeDetails = evaluation.details;
    }

    metrics.push({
      turn: turnNum,
      type: turn.type,
      userTokens,
      assistantTokens: result.usage.outputTokens || estimateTokens(result.text),
      contextBefore,
      contextAfter,
      compactionEvent,
      probeScore,
      probeDetails,
    });

    const icon = turnIcon(turn.type);
    const compactInfo = compactionEvent ? ` [${compactionEvent}]` : "";
    process.stderr.write(
      `  ${icon} Turn ${String(turnNum).padStart(2)}/${TURNS.length} ${turn.type.padEnd(5)} → ${contextAfter} tokens${compactInfo}\n`
    );
  }

  printResults(metrics, contextLimit, blockingThreshold, speculativeThreshold);

  return {
    contextLimit,
    blockingThreshold,
    speculativeThreshold,
    modelId,
    turns: metrics.map((m) => ({
      turn: m.turn,
      type: m.type,
      contextAfter: m.contextAfter,
      compactionEvent: m.compactionEvent || null,
      probeScore: m.probeScore || null,
    })),
    probes: metrics
      .filter((m) => m.type === "probe")
      .map((m) => {
        const parts = (m.probeScore || "0/0").split("/").map(Number);
        return { turn: m.turn, found: parts[0], expected: parts[1] };
      }),
    summary: (() => {
      const probes = metrics.filter((m) => m.type === "probe");
      let found = 0;
      let expected = 0;
      for (const p of probes) {
        const parts = (p.probeScore || "0/0").split("/").map(Number);
        found += parts[0];
        expected += parts[1];
      }
      const compactionCount = metrics.filter((m) =>
        m.compactionEvent.includes("compacted")
      ).length;
      const maxTokens = Math.max(...metrics.map((m) => m.contextAfter));
      return {
        totalFound: found,
        totalExpected: expected,
        retentionPct: expected > 0 ? Math.round((found / expected) * 100) : 0,
        compactionCycles: compactionCount,
        peakTokens: maxTokens,
      };
    })(),
  };
}

const main = defineCommand({
  meta: {
    name: "compaction-benchmark",
    description: "Multi-turn compaction benchmark with memory probes",
  },
  args: {
    contextLimit: {
      alias: ["c"],
      type: "string",
      description: "Context token limit (default: 4096)",
    },
    model: {
      alias: ["m"],
      type: "string",
      description: "Model ID (default: zai-org/GLM-5)",
    },
    output: {
      alias: ["o"],
      type: "string",
      description: "Write JSON results to file path",
    },
    provider: {
      alias: ["p"],
      type: "string",
      description: "Provider: friendli (default) or anthropic",
    },
    baseline: {
      type: "boolean",
      description:
        "Use default compaction prompt instead of chatbot-optimized prompt",
    },
  },
  async run({ args }) {
    const contextLimit = Number.parseInt(args.contextLimit || "4096", 10);
    const provider = args.provider || "friendli";

    let model: LanguageModel;
    let modelId: string;

    if (provider === "anthropic") {
      if (!process.env.ANTHROPIC_API_KEY) {
        process.stderr.write("Error: ANTHROPIC_API_KEY required\n");
        process.exit(1);
      }
      modelId = args.model || "claude-sonnet-4-20250514";
      const anthropic = createAnthropic({});
      model = anthropic(modelId);
    } else {
      if (!process.env.FRIENDLI_TOKEN) {
        process.stderr.write("Error: FRIENDLI_TOKEN required\n");
        process.exit(1);
      }
      modelId = args.model || process.env.FRIENDLI_MODEL || "zai-org/GLM-5";
      const friendli = createFriendli({
        apiKey: process.env.FRIENDLI_TOKEN ?? "",
        baseURL: process.env.FRIENDLI_BASE_URL || "serverless",
        includeUsage: true,
      });
      model = friendli(modelId);
    }

    const result = await runBenchmark({
      baseline: args.baseline === true,
      contextLimit,
      model,
      modelId,
    });

    if (args.output) {
      writeFileSync(args.output, JSON.stringify(result, null, 2));
      process.stderr.write(`\nJSON results written to ${args.output}\n`);
    }
  },
});

runMain(main);
