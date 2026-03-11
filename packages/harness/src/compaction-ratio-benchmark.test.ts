import { describe, expect, it } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import type { PreparedCompaction } from "./index";
import { createAgent, MessageHistory } from "./index";

/**
 * speculativeStartRatio tuning benchmark.
 *
 * Simulates TUI/headless speculative compaction flow across multiple ratio
 * values with the same conversation. Measures speculative preparations,
 * applied compactions, wasted preparations, and blocking compactions.
 *
 * Run: OPENAI_API_KEY=... OPENAI_BASE_URL=... bun test compaction-ratio-benchmark
 */

const OPENAI_API_KEY =
  process.env.COMPACTION_TEST_API_KEY ?? process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL =
  process.env.COMPACTION_TEST_BASE_URL ?? process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.COMPACTION_TEST_MODEL ?? "gpt-4.1-mini";

const describeIfApi =
  OPENAI_API_KEY && process.env.SKIP_E2E !== "1" ? describe : describe.skip;

interface TextMessagePart {
  text: string;
  type: "text";
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (p): p is TextMessagePart =>
        typeof p === "object" && p !== null && "type" in p && p.type === "text"
    )
    .map((part) => part.text)
    .join(" ");
}

interface RatioMetrics {
  actualApplied: number;
  avgTokensAtTrigger: number;
  blockingCompactions: number;
  finalMessages: number;
  finalTokens: number;
  ratio: number;
  rejectedResults: number;
  speculativePreparations: number;
  staleResults: number;
  summaryCount: number;
  totalTokensSaved: number;
  turnsBeforeFirstTrigger: number;
  wastedPreparations: number;
}

describeIfApi("speculativeStartRatio benchmark", () => {
  const CONTEXT_LIMIT = 800;
  const RESERVE_TOKENS = 80;
  const KEEP_RECENT = Math.floor(CONTEXT_LIMIT * 0.3);
  const RATIOS_TO_TEST = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9];

  const openai = createOpenAI({
    apiKey: OPENAI_API_KEY ?? "missing-api-key",
    ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {}),
  });

  const model = openai.chat(OPENAI_MODEL);

  const userMessages = [
    "안녕하세요! 한국어를 배우고 싶어요. 기본 인사말을 알려주세요.",
    "감사합니다! 이제 숫자를 알려주세요. 1부터 10까지요.",
    "좋아요! 이제 요일을 알려주세요. 월요일부터 일요일까지.",
    "이번에는 한국 음식 이름을 10가지 알려주세요.",
    "한국의 유명한 관광지 5곳을 추천해주세요.",
    "한국어 존댓말과 반말의 차이를 설명해주세요.",
    "한국의 전통 명절에 대해 알려주세요.",
    "한국 드라마 추천 5개 해주세요.",
    "한국어의 기본 문법 구조를 설명해주세요.",
    "오늘 배운 것을 복습해주세요.",
    "한국어에서 가장 자주 쓰이는 동사 10개를 알려주세요.",
    "한국의 사계절 특징을 설명해주세요.",
    "한국 문화에서 중요한 예절 5가지를 알려주세요.",
    "마지막으로, 한국어 학습 팁 3가지를 알려주세요.",
  ];

  const createSummarizeFn = () => {
    const summarizerModel = openai.chat(OPENAI_MODEL);
    return async (
      messages: unknown[],
      previousSummary?: string,
      _onDelta?: unknown
    ): Promise<string> => {
      const agent = createAgent({
        model: summarizerModel,
        instructions:
          "Summarize the following conversation in 2-3 sentences. Be very concise. If a previous summary is provided, integrate it.",
      });

      const content = (messages as Array<{ role: string; content: unknown }>)
        .map(
          (m) => `[${m.role}]: ${extractMessageText(m.content).slice(0, 200)}`
        )
        .join("\n");

      const prompt = previousSummary
        ? `Previous summary: ${previousSummary}\n\nNew messages:\n${content}\n\nProvide an integrated summary.`
        : `Summarize:\n${content}`;

      const stream = agent.stream({
        messages: [{ role: "user", content: prompt }],
      });
      const response = await stream.response;
      return (
        response.messages
          .filter((m) => m.role === "assistant")
          .map((m) => {
            if (typeof m.content === "string") {
              return m.content;
            }
            if (Array.isArray(m.content)) {
              return extractMessageText(m.content);
            }
            return "";
          })
          .join("") || "No summary available"
      );
    };
  };

  async function runBenchmarkForRatio(ratio: number): Promise<RatioMetrics> {
    const history = new MessageHistory({
      maxMessages: 200,
      compaction: {
        enabled: true,
        maxTokens: CONTEXT_LIMIT,
        reserveTokens: RESERVE_TOKENS,
        keepRecentTokens: KEEP_RECENT,
        speculativeStartRatio: ratio,
        summarizeFn: createSummarizeFn(),
      },
    });
    history.setContextLimit(CONTEXT_LIMIT);

    const agent = createAgent({
      model,
      instructions:
        "You are a helpful Korean tutor. Respond in Korean. Keep responses under 80 characters.",
    });

    const metrics: RatioMetrics = {
      ratio,
      speculativePreparations: 0,
      actualApplied: 0,
      wastedPreparations: 0,
      blockingCompactions: 0,
      staleResults: 0,
      rejectedResults: 0,
      totalTokensSaved: 0,
      finalTokens: 0,
      finalMessages: 0,
      summaryCount: 0,
      turnsBeforeFirstTrigger: -1,
      avgTokensAtTrigger: 0,
    };

    let pendingSpeculative: {
      promise: Promise<PreparedCompaction | null>;
      resolved: PreparedCompaction | null;
      done: boolean;
    } | null = null;

    const triggerTokens: number[] = [];

    const tryApplySpeculative = (): void => {
      if (!(pendingSpeculative?.done && pendingSpeculative.resolved)) {
        return;
      }

      const result = history.applyPreparedCompaction(
        pendingSpeculative.resolved
      );
      if (result.applied) {
        metrics.actualApplied++;
        metrics.totalTokensSaved += pendingSpeculative.resolved.tokenDelta ?? 0;
      } else if (result.reason === "stale") {
        metrics.staleResults++;
      } else if (result.reason === "rejected") {
        metrics.rejectedResults++;
      } else if (result.reason === "noop") {
        metrics.wastedPreparations++;
      }
      pendingSpeculative = null;
    };

    const startSpeculative = async (turn: number): Promise<void> => {
      if (pendingSpeculative) {
        return;
      }
      if (!history.shouldStartSpeculativeCompactionForNextTurn()) {
        return;
      }

      metrics.speculativePreparations++;
      triggerTokens.push(history.getEstimatedTokens());
      if (metrics.turnsBeforeFirstTrigger === -1) {
        metrics.turnsBeforeFirstTrigger = turn + 1;
      }

      const spec: {
        promise: Promise<PreparedCompaction | null>;
        resolved: PreparedCompaction | null;
        done: boolean;
      } = { promise: Promise.resolve(null), resolved: null, done: false };

      spec.promise = history
        .prepareSpeculativeCompaction({ phase: "new-turn" })
        .then((result) => {
          spec.resolved = result;
          spec.done = true;
          return result;
        });

      pendingSpeculative = spec;
      await spec.promise;
    };

    for (let turn = 0; turn < userMessages.length; turn++) {
      // Phase 1: hard limit check before user message (mirrors headless waitForSpeculativeCompactionIfNeeded)
      tryApplySpeculative();
      if (history.isAtHardContextLimit()) {
        const tokensBefore = history.getEstimatedTokens();
        await history.compact();
        metrics.blockingCompactions++;
        metrics.totalTokensSaved += Math.max(
          0,
          tokensBefore - history.getEstimatedTokens()
        );
        pendingSpeculative = null;
      }

      // Phase 2: add user message (mirrors headless addUserMessage)
      history.addUserMessage(userMessages[turn]);

      // Phase 3: apply speculative + start new before LLM call (mirrors processAgentResponse L257-265)
      tryApplySpeculative();
      await startSpeculative(turn);

      // Phase 4: stream to LLM
      const stream = agent.stream({
        messages: history.getMessagesForLLM(),
      });
      const [response, usage] = await Promise.all([
        stream.response,
        stream.usage,
      ]);

      // Phase 5: apply speculative after stream, add model messages (mirrors L278-284)
      tryApplySpeculative();
      if (response.messages.length > 0) {
        history.addModelMessages(response.messages);
      }
      if (usage) {
        history.updateActualUsage(usage);
      }

      // Phase 6: start speculative for next turn (mirrors L288/292)
      await startSpeculative(turn);
    }

    tryApplySpeculative();

    metrics.finalTokens = history.getEstimatedTokens();
    metrics.finalMessages = history.getAll().length;
    metrics.summaryCount = history.getSummaries().length;
    metrics.avgTokensAtTrigger =
      triggerTokens.length > 0
        ? Math.round(
            triggerTokens.reduce((a, b) => a + b, 0) / triggerTokens.length
          )
        : 0;

    return metrics;
  }

  it("compares speculativeStartRatio values", async () => {
    console.log(`\n${"=".repeat(90)}`);
    console.log("  SPECULATIVE START RATIO BENCHMARK");
    console.log(
      `  Context: ${CONTEXT_LIMIT} tokens | Reserve: ${RESERVE_TOKENS} | KeepRecent: ${KEEP_RECENT}`
    );
    console.log(`  Model: ${OPENAI_MODEL} | Turns: ${userMessages.length}`);
    console.log("=".repeat(90));

    const allMetrics: RatioMetrics[] = [];

    for (const ratio of RATIOS_TO_TEST) {
      console.log(`\n  ▸ Testing ratio=${ratio}...`);
      const metrics = await runBenchmarkForRatio(ratio);
      allMetrics.push(metrics);

      console.log(
        `    spec=${metrics.speculativePreparations} applied=${metrics.actualApplied} ` +
          `wasted=${metrics.wastedPreparations} blocking=${metrics.blockingCompactions} ` +
          `stale=${metrics.staleResults} rejected=${metrics.rejectedResults}`
      );
    }

    console.log(`\n${"=".repeat(90)}`);
    console.log("  RESULTS");
    console.log("=".repeat(90));
    console.log(
      "  Ratio  | Spec | Applied | Wasted | Blocking | Stale | Rejected | Saved  | Final  | 1st Trg | Avg@Trg"
    );
    console.log(`  ${"-".repeat(88)}`);

    for (const m of allMetrics) {
      const firstTrigger =
        m.turnsBeforeFirstTrigger === -1
          ? "  never"
          : `T${String(m.turnsBeforeFirstTrigger).padStart(5)}`;
      console.log(
        `  ${m.ratio.toFixed(2).padStart(5)} ` +
          `| ${String(m.speculativePreparations).padStart(4)} ` +
          `| ${String(m.actualApplied).padStart(7)} ` +
          `| ${String(m.wastedPreparations).padStart(6)} ` +
          `| ${String(m.blockingCompactions).padStart(8)} ` +
          `| ${String(m.staleResults).padStart(5)} ` +
          `| ${String(m.rejectedResults).padStart(8)} ` +
          `| ${String(m.totalTokensSaved).padStart(5)}t ` +
          `| ${String(m.finalTokens).padStart(5)}t ` +
          `| ${firstTrigger} ` +
          `| ${String(m.avgTokensAtTrigger).padStart(6)}t`
      );
    }

    // Score: maximize context preservation, penalize blocking/waste, minimize API calls
    // finalTokens = context preserved (higher = better)
    // speculativePreparations = API calls spent (fewer = better)
    // blockingCompactions = speculative wasn't ready in time (heavily penalized)
    const maxFinalTokens = Math.max(...allMetrics.map((m) => m.finalTokens), 1);

    console.log(`\n${"-".repeat(90)}`);
    console.log(
      "  Ratio  | CtxPreserved | API Calls | Blocking | Score  | Verdict"
    );
    console.log(`  ${"-".repeat(88)}`);

    let bestScore = Number.NEGATIVE_INFINITY;
    let bestRatio = 0.8;

    for (const m of allMetrics) {
      const contextScore = (m.finalTokens / maxFinalTokens) * 50;
      const apiCallPenalty = m.speculativePreparations * 5;
      const blockingPenalty = m.blockingCompactions * 30;
      const wastePenalty = m.wastedPreparations * 3;
      const score = Math.round(
        contextScore - apiCallPenalty - blockingPenalty - wastePenalty
      );

      let verdict = "✅ GOOD";
      if (m.blockingCompactions > 0) {
        verdict = "⚠️  TOO LATE";
      } else if (m.speculativePreparations > 3) {
        verdict = "⚠️  TOO FREQUENT";
      } else if (
        m.speculativePreparations === 0 &&
        m.finalTokens < CONTEXT_LIMIT * 0.5
      ) {
        verdict = "⚠️  NO BENEFIT";
      }

      console.log(
        `  ${m.ratio.toFixed(2).padStart(5)} ` +
          `| ${`${((m.finalTokens / maxFinalTokens) * 100).toFixed(0)}%`.padStart(11)} ` +
          `| ${String(m.speculativePreparations).padStart(9)} ` +
          `| ${String(m.blockingCompactions).padStart(8)} ` +
          `| ${String(score).padStart(6)} ` +
          `| ${verdict}`
      );

      if (score > bestScore) {
        bestScore = score;
        bestRatio = m.ratio;
      }
    }

    console.log(`\n${"=".repeat(90)}`);
    console.log(`  🏆 OPTIMAL RATIO: ${bestRatio} (score=${bestScore})`);
    console.log(`${"=".repeat(90)}\n`);

    expect(allMetrics.length).toBe(RATIOS_TO_TEST.length);
    for (const m of allMetrics) {
      expect(m.speculativePreparations).toBeGreaterThanOrEqual(0);
      expect(
        m.actualApplied +
          m.wastedPreparations +
          m.staleResults +
          m.rejectedResults
      ).toBeLessThanOrEqual(m.speculativePreparations);
    }
  }, 300_000);
});
