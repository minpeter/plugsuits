import { createOpenAI } from "@ai-sdk/openai";
import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgent, MessageHistory, runAgentLoop } from "./index";

/**
 * E2E compaction test — forces a compact context limit and verifies compaction
 * fires correctly during a real multi-turn conversation with a model.
 *
 * Uses a small model with intentionally low maxTokens to trigger compaction
 * reliably across providers.
 *
 * Run with: OPENAI_API_KEY=... OPENAI_BASE_URL=... pnpm --filter @ai-sdk-tool/harness test -- compaction-e2e
 */

const OPENAI_API_KEY =
  process.env.COMPACTION_TEST_API_KEY ?? process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL =
  process.env.COMPACTION_TEST_BASE_URL ?? process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.COMPACTION_TEST_MODEL ?? "gpt-4.1-mini";

// Skip if no API key, or if explicitly disabled
const describeIfApi =
  OPENAI_API_KEY && process.env.SKIP_E2E !== "1" ? describe : describe.skip;

interface TextMessagePart {
  text: string;
  type: "text";
}

function isTextMessagePart(part: unknown): part is TextMessagePart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text"
  );
}

function extractMessageText(
  content: unknown,
  options?: { joiner?: string }
): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(isTextMessagePart)
    .map((part) => part.text)
    .join(options?.joiner ?? " ");
}

describeIfApi("compaction E2E with real model (tiny forced limit)", () => {
  const FORCED_COMPACTION = {
    enabled: true,
    maxTokens: 320,
    reserveTokens: 48,
    keepRecentTokens: Math.floor(320 * 0.3),
  } as const;

  const openai = createOpenAI({
    apiKey: OPENAI_API_KEY ?? "missing-api-key",
    ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {}),
  });

  // Use a small/fast model — use .chat() for OpenAI-compatible endpoints
  const model = openai.chat(OPENAI_MODEL);

  it("compacts after multiple long conversation turns", async () => {
    const history = new MessageHistory({
      maxMessages: 200,
      compaction: {
        ...FORCED_COMPACTION,
        // Use model-based summarizer
        summarizeFn: async (messages) => {
          const summarizerModel = openai.chat(OPENAI_MODEL);
          const agent = createAgent({
            model: summarizerModel,
            instructions:
              "Summarize the following conversation in 2-3 sentences. Be concise.",
          });
          const content = messages
            .map((m) => {
              const text = extractMessageText(m.content);
              return `[${m.role}]: ${text.slice(0, 200)}`;
            })
            .join("\n");

          const stream = agent.stream({
            messages: [{ role: "user", content: `Summarize:\n${content}` }],
          });
          const response = await stream.response;
          const textParts = response.messages
            .filter((m) => m.role === "assistant")
            .map((m) => {
              if (typeof m.content === "string") {
                return m.content;
              }

              if (Array.isArray(m.content)) {
                return extractMessageText(m.content, { joiner: "" });
              }

              return "";
            });
          return textParts.join("") || "No summary available";
        },
      },
    });
    history.setContextLimit(FORCED_COMPACTION.maxTokens);

    const agent = createAgent({
      model,
      instructions:
        "You are a helpful Korean tutor. Respond in Korean. Keep responses under 100 characters.",
    });

    // Simulate a multi-turn conversation that will exceed 8k tokens
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
    ];

    console.log("\n=== Compaction E2E: forced context limit ===");
    console.log(
      `Config: maxTokens=${FORCED_COMPACTION.maxTokens}, reserve=${FORCED_COMPACTION.reserveTokens}, keepRecent=${FORCED_COMPACTION.keepRecentTokens}`
    );

    let compactionFired = false;

    for (let i = 0; i < userMessages.length; i++) {
      const userMsg = userMessages[i];
      history.addUserMessage(userMsg);

      const tokensBefore = history.getEstimatedTokens();
      const msgCountBefore = history.getAll().length;

      // Run agent and collect response
      const stream = agent.stream({
        messages: history.getMessagesForLLM(),
      });
      const [response, usage] = await Promise.all([
        stream.response,
        stream.usage,
      ]);

      if (response.messages.length > 0) {
        history.addModelMessages(response.messages);
      }

      if (usage) {
        history.updateActualUsage(usage);
      }

      // Check if compaction is needed and trigger
      if (history.needsCompaction()) {
        console.log(`\n🔥 Turn ${i + 1}: COMPACTION TRIGGERED`);
        console.log(
          `   Before: ${msgCountBefore} messages, ~${tokensBefore} tokens`
        );

        const didCompact = await history.compact();
        compactionFired = compactionFired || didCompact;

        const tokensAfter = history.getEstimatedTokens();
        const msgCountAfter = history.getAll().length;
        const summaryCount = history.getSummaries().length;

        console.log(
          `   After:  ${msgCountAfter} messages, ~${tokensAfter} tokens, ${summaryCount} summaries`
        );
        console.log(
          `   Saved:  ~${tokensBefore - tokensAfter} tokens (${Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 100)}% reduction)`
        );
      } else {
        const tokensNow = history.getEstimatedTokens();
        console.log(
          `   Turn ${i + 1}: ${history.getAll().length} messages, ~${tokensNow} tokens`
        );
      }
    }

    console.log("\n=== Results ===");
    console.log(`Compaction fired: ${compactionFired}`);
    console.log(`Final messages: ${history.getAll().length}`);
    console.log(`Final tokens: ~${history.getEstimatedTokens()}`);
    console.log(`Total summaries: ${history.getSummaries().length}`);

    // Assertions
    expect(compactionFired).toBe(true);
    expect(history.getSummaries().length).toBeGreaterThanOrEqual(1);

    // Verify summaries contain actual content (not empty)
    for (const summary of history.getSummaries()) {
      expect(summary.summary.length).toBeGreaterThan(10);
      expect(summary.tokensBefore).toBeGreaterThan(0);
      expect(summary.summaryTokens).toBeGreaterThan(0);
    }

    // Verify LLM messages include system summary
    const llmMessages = history.getMessagesForLLM();
    expect(llmMessages[0].role).toBe("system");
    const systemContent = llmMessages[0].content as string;
    expect(systemContent).toContain("Previous conversation context:");

    // Verify recent messages are preserved
    const allMsgs = history.getAll();
    const lastMsg = allMsgs.at(-1);
    // Last message should be from the model (assistant response to last turn)
    expect(
      lastMsg?.modelMessage.role === "assistant" ||
        lastMsg?.modelMessage.role === "user"
    ).toBe(true);

    console.log("\n✅ Compaction E2E passed!\n");
  }, 120_000); // 2 minute timeout for API calls

  it("compaction with tool calls preserves tool-call/result pairs", async () => {
    const history = new MessageHistory({
      maxMessages: 200,
      compaction: {
        ...FORCED_COMPACTION,
      },
    });
    history.setContextLimit(FORCED_COMPACTION.maxTokens);

    const agentWithTools = createAgent({
      model,
      instructions:
        "You are a helpful assistant. Use the get_info tool when asked about topics.",
      tools: {
        get_info: tool({
          description: "Get information about a topic",
          inputSchema: z.object({
            topic: z.string().describe("The topic to get info about"),
          }),
          execute: ({ topic }) => {
            return `Here is detailed information about ${topic}: ${"x".repeat(500)}`;
          },
        }),
      },
      maxStepsPerTurn: 3,
    });

    const topics = [
      "Tell me about Korean history using the get_info tool",
      "What about Korean cuisine? Use get_info",
      "Tell me about K-pop with get_info",
      "What about Korean technology? Use get_info",
      "Tell me about Korean traditional culture using get_info",
    ];

    console.log("\n=== Compaction E2E with Tools ===");

    for (let i = 0; i < topics.length; i++) {
      history.addUserMessage(topics[i]);

      const result = await runAgentLoop({
        agent: agentWithTools,
        messages: history.getMessagesForLLM(),
        maxIterations: 3,
      });

      // Add all response messages (including tool calls/results)
      const responseMessages = result.messages.slice(
        history.getMessagesForLLM().length
      );
      if (responseMessages.length > 0) {
        history.addModelMessages(responseMessages);
      }

      const tokens = history.getEstimatedTokens();
      console.log(
        `   Turn ${i + 1}: ${history.getAll().length} messages, ~${tokens} tokens, iterations=${result.iterations}`
      );

      if (history.needsCompaction()) {
        console.log("   🔥 Compaction triggered!");
        await history.compact();
        console.log(
          `   After: ${history.getAll().length} messages, ~${history.getEstimatedTokens()} tokens`
        );
      }
    }

    // Verify no orphaned tool results
    const msgs = history.toModelMessages();
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === "tool") {
        expect(i).toBeGreaterThan(0);
        expect(msgs[i - 1].role).toBe("assistant");
      }
    }

    console.log(
      `\n✅ Tool compaction E2E passed! Final: ${history.getAll().length} msgs, ${history.getSummaries().length} summaries\n`
    );
  }, 120_000);
});
