import { describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  COMPACTION_DEBUG: false,
  CONTEXT_LIMIT_OVERRIDE: undefined as number | undefined,
  DISABLE_AUTO_COMPACT: false,
  DEBUG_TOKENS: false,
}));
vi.mock("./env", () => ({ env: mockEnv }));

import { CheckpointHistory } from "./checkpoint-history";
import { CompactionOrchestrator } from "./compaction-orchestrator";

/**
 * Integration test simulating the 32k context scenario:
 * - User asks "investigate the codebase in detail"
 * - Agent calls tools repeatedly, producing large tool results
 * - Context fills up, compaction must happen
 * - Verify: speculative compaction works, no blocking flood, no infinite loop
 */

interface SimulatedAgentTurn {
  assistantResponse?: string;
  toolResult?: string;
  userMessage?: string;
}

function estimateSerializedLength(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value).length;
  }
  return 0;
}

function createRealisticSummarizer(options?: {
  savingsRatio?: number;
}): (messages: unknown[]) => Promise<string> {
  const savingsRatio = options?.savingsRatio ?? 0.7;
  return (messages) => {
    const totalChars = (messages as { content?: unknown }[]).reduce(
      (sum, m) => sum + estimateSerializedLength(m.content),
      0
    );
    const targetChars = Math.max(
      50,
      Math.floor(totalChars * (1 - savingsRatio))
    );
    const word = "summary-word ";
    const summary = word.repeat(Math.ceil(targetChars / word.length));
    return Promise.resolve(summary.slice(0, targetChars));
  };
}

describe("32k context scenario integration", () => {
  const CONTEXT_LIMIT = 32_000;
  const TRIGGER_TOKENS = CONTEXT_LIMIT * 0.5;

  it("realistic scenario: verbose investigation with good summaries", async () => {
    const summaryCallLog: number[] = [];
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: CONTEXT_LIMIT,
        maxTokens: Math.floor(CONTEXT_LIMIT * 0.5),
        keepRecentTokens: 200,
        reserveTokens: 1000,
        thresholdRatio: 0.5,
        summarizeFn: (messages) => {
          summaryCallLog.push(history.getEstimatedTokens());
          return createRealisticSummarizer({
            savingsRatio: 0.7,
          })(messages);
        },
      },
    });
    const orchestrator = new CompactionOrchestrator(history);

    orchestrator.notifyNewUserTurn();
    history.addUserMessage(
      "Please investigate this codebase in as much detail as possible. Look at every module, understand the architecture, and summarize your findings."
    );

    const simulatedToolResult =
      "This is a large tool output from grep/read_file with many lines of code that takes up significant context. ".repeat(
        40
      );

    const turns: SimulatedAgentTurn[] = [];
    let blockingCompactions = 0;
    let speculativeApplied = 0;
    let ineffectiveHits = 0;

    for (let turn = 0; turn < 20; turn += 1) {
      history.addModelMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${turn}`,
              toolName: "read_file",
              input: { path: `src/module-${turn}.ts` },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: `call-${turn}`,
              toolName: "read_file",
              output: {
                type: "text",
                value: `${simulatedToolResult} (turn ${turn})`,
              },
            },
          ],
        },
      ]);

      orchestrator.startSpeculative();
      const speculativeJob =
        orchestrator.getLatestRunningSpeculativeCompaction();
      if (speculativeJob) {
        await speculativeJob.promise;
      }

      const applyResult = orchestrator.applyReady();
      if (applyResult.applied) {
        speculativeApplied += 1;
      }

      const didBlocking = await orchestrator.checkAndCompact();
      if (didBlocking) {
        blockingCompactions += 1;
      }

      ineffectiveHits = orchestrator.getIneffectiveAttemptsThisTurn();

      turns.push({
        toolResult: simulatedToolResult,
        assistantResponse: `Step ${turn}`,
      });
    }

    console.log(
      `[integration] summaryCalls=${summaryCallLog.length}, speculative=${speculativeApplied}, blocking=${blockingCompactions}, ineffective=${ineffectiveHits}, finalTokens=${history.getEstimatedTokens()}, trigger=${TRIGGER_TOKENS}`
    );

    expect(history.getEstimatedTokens()).toBeLessThan(CONTEXT_LIMIT);
    expect(summaryCallLog.length).toBeGreaterThan(0);
  }, 10_000);

  it("pathological scenario: LLM produces verbose summaries that don't fit", async () => {
    let summaryCallCount = 0;
    const verboseSummary = (_messages: unknown[]): Promise<string> => {
      summaryCallCount += 1;
      return Promise.resolve(
        "I carefully reviewed all the previous conversation and tool outputs. The user asked to investigate the codebase and I performed multiple file reads and grep searches across modules. Each search revealed complex interdependencies between components that require careful analysis. The architecture shows a monorepo with multiple packages each serving distinct purposes including harness tui headless and cea packages. ".repeat(
          80
        )
      );
    };

    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: CONTEXT_LIMIT,
        maxTokens: Math.floor(CONTEXT_LIMIT * 0.5),
        keepRecentTokens: 200,
        reserveTokens: 1000,
        thresholdRatio: 0.5,
        summarizeFn: verboseSummary,
      },
    });
    const orchestrator = new CompactionOrchestrator(history);

    orchestrator.notifyNewUserTurn();
    history.addUserMessage(
      "Investigate the codebase in extreme detail, examining every file."
    );

    const largeToolResult =
      "Tool output containing lots of source code lines and file contents ".repeat(
        200
      );

    let blockingCount = 0;

    for (let turn = 0; turn < 30; turn += 1) {
      history.addModelMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${turn}`,
              toolName: "read_file",
              input: { path: `src/file-${turn}.ts` },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: `call-${turn}`,
              toolName: "read_file",
              output: { type: "text", value: largeToolResult },
            },
          ],
        },
      ]);

      orchestrator.startSpeculative();
      const job = orchestrator.getLatestRunningSpeculativeCompaction();
      if (job) {
        await job.promise;
      }
      orchestrator.applyReady();

      const didBlocking = await orchestrator.checkAndCompact();
      if (didBlocking) {
        blockingCount += 1;
      }
    }

    console.log(
      `[pathological] summaryCalls=${summaryCallCount}, blocking=${blockingCount}, ineffectiveAttempts=${orchestrator.getIneffectiveAttemptsThisTurn()}, capReached=${orchestrator.isCompactionCapReached()}, finalTokens=${history.getEstimatedTokens()}, trigger=${TRIGGER_TOKENS}`
    );

    expect(summaryCallCount).toBeGreaterThan(0);
    expect(orchestrator.isCompactionCapReached()).toBe(true);
    expect(blockingCount).toBe(0);
  }, 15_000);

  it("multi-turn scenario: cap resets between user turns", async () => {
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: CONTEXT_LIMIT,
        maxTokens: Math.floor(CONTEXT_LIMIT * 0.5),
        keepRecentTokens: 200,
        reserveTokens: 1000,
        thresholdRatio: 0.5,
        summarizeFn: createRealisticSummarizer({ savingsRatio: 0.6 }),
      },
    });
    const orchestrator = new CompactionOrchestrator(history);

    const largeOutput = "tool data ".repeat(2000);

    for (let userTurn = 0; userTurn < 3; userTurn += 1) {
      orchestrator.notifyNewUserTurn();
      history.addUserMessage(`User turn ${userTurn}: continue investigation`);

      for (let step = 0; step < 10; step += 1) {
        history.addModelMessages([
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: `u${userTurn}-s${step}`,
                toolName: "grep",
                input: { pattern: `term-${step}` },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: `u${userTurn}-s${step}`,
                toolName: "grep",
                output: { type: "text", value: largeOutput },
              },
            ],
          },
        ]);

        orchestrator.startSpeculative();
        const job = orchestrator.getLatestRunningSpeculativeCompaction();
        if (job) {
          await job.promise;
        }
        orchestrator.applyReady();
        await orchestrator.checkAndCompact();
      }

      expect(history.getEstimatedTokens()).toBeLessThan(CONTEXT_LIMIT);
    }

    console.log(
      `[multi-turn] finalTokens=${history.getEstimatedTokens()}, accepted=${orchestrator.getAcceptedCompactionsThisTurn()}, capReached=${orchestrator.isCompactionCapReached()}`
    );
  }, 15_000);

  it("no emergency blocking even with verbose summaries at high context usage", async () => {
    const events: string[] = [];
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: CONTEXT_LIMIT,
        maxTokens: Math.floor(CONTEXT_LIMIT * 0.5),
        keepRecentTokens: 200,
        reserveTokens: 1000,
        thresholdRatio: 0.5,
        summarizeFn: createRealisticSummarizer({ savingsRatio: 0.3 }),
      },
    });
    const orchestrator = new CompactionOrchestrator(history, {
      callbacks: {
        onCompactionComplete: (result) =>
          events.push(
            `compaction: success=${result.success} tokensBefore=${result.tokensBefore} tokensAfter=${result.tokensAfter}`
          ),
        onBlockingChange: (event) => {
          if (event.blocking) {
            events.push(
              `BLOCKING: reason=${event.reason} stage=${event.stage}`
            );
          }
        },
      },
    });

    orchestrator.notifyNewUserTurn();
    history.addUserMessage("Investigate the entire monorepo");

    const prepareMessages = async (): Promise<void> => {
      orchestrator.applyReady();
      await orchestrator.blockAtHardLimit(0, "new-turn");
      await orchestrator.checkAndCompact();
      orchestrator.applyReady();
      orchestrator.startSpeculative();
    };

    for (let step = 0; step < 30; step += 1) {
      await prepareMessages();

      history.addModelMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${step}`,
              toolName: "read_file",
              input: { path: `src/file-${step}.ts` },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: `call-${step}`,
              toolName: "read_file",
              output: { type: "text", value: "file content ".repeat(800) },
            },
          ],
        },
      ]);
    }

    const job = orchestrator.getLatestRunningSpeculativeCompaction();
    if (job) {
      await job.promise;
    }

    const emergencyBlocking = events.filter((e) =>
      e.startsWith("BLOCKING: reason=hard-limit")
    );
    const regularCompactions = events.filter((e) =>
      e.startsWith("compaction: success=true")
    );

    console.log(
      `[verbose-high-usage] emergency=${emergencyBlocking.length}, compactions=${regularCompactions.length}, finalTokens=${history.getEstimatedTokens()}, events=${events.length}`
    );

    expect(emergencyBlocking.length).toBe(0);
    expect(history.getEstimatedTokens()).toBeLessThan(CONTEXT_LIMIT);
  }, 15_000);

  it("full TUI flow simulation: tool loop with preparMessages and startSpeculative", async () => {
    const events: string[] = [];
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: CONTEXT_LIMIT,
        maxTokens: Math.floor(CONTEXT_LIMIT * 0.5),
        keepRecentTokens: 200,
        reserveTokens: 1000,
        thresholdRatio: 0.5,
        summarizeFn: createRealisticSummarizer({ savingsRatio: 0.7 }),
      },
    });
    const orchestrator = new CompactionOrchestrator(history, {
      callbacks: {
        onCompactionStart: () => events.push("compaction-start"),
        onCompactionComplete: (result) =>
          events.push(
            `complete: success=${result.success} reason=${result.reason ?? "ok"}`
          ),
        onBlockingChange: (event) => {
          if (event.blocking) {
            events.push(`BLOCKING-START: ${event.reason}`);
          }
        },
      },
    });

    const prepareMessages = async (): Promise<void> => {
      const readyResult = orchestrator.applyReady();
      if (readyResult.stale) {
        orchestrator.startSpeculative();
      }

      const didBlocking = await orchestrator.checkAndCompact();
      if (didBlocking) {
        events.push("did-blocking-compact");
      }
      orchestrator.applyReady();

      orchestrator.startSpeculative();
    };

    orchestrator.notifyNewUserTurn();
    history.addUserMessage("Please investigate the codebase in detail");

    for (let toolCall = 0; toolCall < 25; toolCall += 1) {
      await prepareMessages();

      history.addModelMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: `t${toolCall}`,
              toolName: "read_file",
              input: { path: `src/file-${toolCall}.ts` },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: `t${toolCall}`,
              toolName: "read_file",
              output: {
                type: "text",
                value: "file contents with many lines of code ".repeat(300),
              },
            },
          ],
        },
      ]);
    }

    const job = orchestrator.getLatestRunningSpeculativeCompaction();
    if (job) {
      await job.promise;
    }

    const blockingEvents = events.filter((e) => e.startsWith("BLOCKING-START"));
    const completedCompactions = events.filter((e) =>
      e.startsWith("complete: success=true")
    ).length;

    console.log(
      `[full-tui-flow] events=${events.length}, blocking=${blockingEvents.length}, completed=${completedCompactions}, finalTokens=${history.getEstimatedTokens()}`
    );

    expect(blockingEvents.length).toBe(0);
    expect(completedCompactions).toBeGreaterThan(0);
    expect(history.getEstimatedTokens()).toBeLessThan(CONTEXT_LIMIT * 0.8);
  }, 15_000);

  it("reproduces TUI flow: speculative running concurrently with checkAndCompact", async () => {
    let slowSummaryResolve: ((value: string) => void) | undefined;
    const slowSummary = (_messages: unknown[]): Promise<string> =>
      new Promise((resolve) => {
        slowSummaryResolve = resolve;
      });

    const events: string[] = [];
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: CONTEXT_LIMIT,
        maxTokens: Math.floor(CONTEXT_LIMIT * 0.5),
        keepRecentTokens: 200,
        reserveTokens: 1000,
        thresholdRatio: 0.5,
        summarizeFn: slowSummary,
      },
    });
    const orchestrator = new CompactionOrchestrator(history, {
      callbacks: {
        onCompactionStart: () => events.push("start"),
        onCompactionComplete: (result) =>
          events.push(`complete: success=${result.success}`),
        onBlockingChange: (event) => {
          if (event.blocking) {
            events.push(`blocking-start: ${event.reason}`);
          }
        },
      },
    });

    orchestrator.notifyNewUserTurn();
    history.addUserMessage("Investigate in detail");

    for (let i = 0; i < 30; i += 1) {
      history.addModelMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: `c${i}`,
              toolName: "read",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: `c${i}`,
              toolName: "read",
              output: { type: "text", value: "content ".repeat(1000) },
            },
          ],
        },
      ]);
    }

    orchestrator.startSpeculative();
    expect(orchestrator.isRunning()).toBe(true);

    const didBlocking = await orchestrator.checkAndCompact();
    expect(didBlocking).toBe(false);

    history.addModelMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c-extra",
            toolName: "read",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c-extra",
            toolName: "read",
            output: { type: "text", value: "content ".repeat(300) },
          },
        ],
      },
    ]);

    slowSummaryResolve?.("short");
    await orchestrator.getLatestRunningSpeculativeCompaction()?.promise;
    orchestrator.applyReady();

    const blockingEvents = events.filter((e) => e.startsWith("blocking-start"));
    console.log(
      `[concurrent-flow] events=${events.length}, blocking=${blockingEvents.length}, finalTokens=${history.getEstimatedTokens()}`
    );

    expect(blockingEvents.length).toBe(0);
  }, 10_000);

  it("speculative vs blocking: speculative should win when summary is good", async () => {
    const events: string[] = [];
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: CONTEXT_LIMIT,
        maxTokens: Math.floor(CONTEXT_LIMIT * 0.5),
        keepRecentTokens: 200,
        reserveTokens: 1000,
        thresholdRatio: 0.5,
        summarizeFn: createRealisticSummarizer({ savingsRatio: 0.7 }),
      },
    });
    const orchestrator = new CompactionOrchestrator(history, {
      callbacks: {
        onCompactionComplete: (result) => {
          events.push(
            `complete: success=${result.success}, reason=${result.reason ?? "ok"}`
          );
        },
        onBlockingChange: (event) => {
          if (event.blocking) {
            events.push(`blocking-start: ${event.reason}`);
          }
        },
      },
    });

    orchestrator.notifyNewUserTurn();
    history.addUserMessage("Investigate in detail");

    for (let turn = 0; turn < 8; turn += 1) {
      history.addModelMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: `c${turn}`,
              toolName: "read_file",
              input: { path: `file-${turn}` },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: `c${turn}`,
              toolName: "read_file",
              output: {
                type: "text",
                value: "large file content ".repeat(2000),
              },
            },
          ],
        },
      ]);

      orchestrator.startSpeculative();
      const job = orchestrator.getLatestRunningSpeculativeCompaction();
      if (job) {
        await job.promise;
      }
      orchestrator.applyReady();
      await orchestrator.checkAndCompact();
    }

    const blockingCount = events.filter((e) =>
      e.startsWith("blocking-start:")
    ).length;
    const successfulCompactions = events.filter(
      (e) => e.includes("complete:") && e.includes("success=true")
    ).length;

    console.log(
      `[speculative-vs-blocking] blockingEvents=${blockingCount}, successful=${successfulCompactions}, finalTokens=${history.getEstimatedTokens()}`
    );
    console.log(`[events]\n${events.join("\n")}`);

    expect(successfulCompactions).toBeGreaterThan(0);
    expect(blockingCount).toBe(0);
  }, 15_000);
});
