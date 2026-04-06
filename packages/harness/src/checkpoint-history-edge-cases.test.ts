import type { ModelMessage, ToolCallPart } from "ai";
import { describe, expect, it, vi } from "vitest";
import { CheckpointHistory } from "./checkpoint-history";
import { CompactionOrchestrator } from "./compaction-orchestrator";

interface LegacyTestClassification {
  legacy: string;
  migratedAs?: string;
  reason?: string;
  status: "PRESERVED" | "ADAPTED" | "OBSOLETED";
}

const LEGACY_MESSAGE_HISTORY_CLASSIFICATIONS = [
  ...[
    "trims trailing newlines",
    "returns original when no trailing newlines",
    "trims when last element is TextPart with newlines",
    "trims TextPart even when ToolCallPart comes after",
    "returns original when only ToolCallPart exists",
    "trims last TextPart when ToolCallPart comes before",
    "returns original when empty array",
    "returns original when TextPart has no trailing newlines",
  ].map(
    (legacy) =>
      ({
        legacy,
        migratedAs:
          legacy === "trims trailing newlines" ||
          legacy === "returns original when no trailing newlines"
            ? "ADAPTED/PRESERVED: trims assistant string content when storing model messages"
            : "ADAPTED: trims the last assistant text part while preserving tool-call parts",
        status: "ADAPTED",
      }) satisfies LegacyTestClassification
  ),
  {
    legacy: "always trims trailing newlines when storing assistant messages",
    migratedAs:
      "ADAPTED/PRESERVED: trims assistant string content when storing model messages",
    status: "PRESERVED",
  },
  {
    legacy: "stores originalContent for translated user messages",
    migratedAs:
      "PRESERVED: stores originalContent for translated user messages",
    status: "PRESERVED",
  },
  {
    legacy: "keeps originalContent undefined for English user messages",
    migratedAs:
      "PRESERVED: keeps originalContent undefined for English user messages",
    status: "PRESERVED",
  },
  ...[
    "trims oldest messages (except first) when exceeding maxMessages",
    "preserves first message when addModelMessages causes overflow",
    "does not trim when at exactly maxMessages",
    "handles maxMessages = 1 by keeping only the last message",
    "throws RangeError for maxMessages = 0",
    "throws RangeError for negative maxMessages",
    "defaults to 1000 when no options provided",
    "handles large batch addModelMessages that exceeds limit",
    "getAll returns correct count after trimming",
    "throws RangeError for NaN maxMessages",
    "throws RangeError for non-integer maxMessages",
    "throws RangeError for Infinity maxMessages",
  ].map(
    (legacy) =>
      ({
        legacy,
        reason:
          "CheckpointHistory removed maxMessages trimming in favor of append-only history.",
        status: "OBSOLETED",
      }) satisfies LegacyTestClassification
  ),
  {
    legacy: "is disabled by default",
    migratedAs: "PRESERVED: is disabled by default",
    status: "PRESERVED",
  },
  {
    legacy: "can be enabled via options",
    migratedAs: "PRESERVED: can be enabled via options",
    status: "PRESERVED",
  },
  ...[
    "returns empty summaries when compaction is disabled",
    "returns empty summaries initially when enabled",
  ].map(
    (legacy) =>
      ({
        legacy,
        migratedAs:
          "ADAPTED: starts without a checkpoint regardless of compaction config",
        status: "ADAPTED",
      }) satisfies LegacyTestClassification
  ),
  {
    legacy: "getMessagesForLLM returns plain messages when no summaries",
    migratedAs:
      "PRESERVED: getMessagesForLLM returns plain messages when no checkpoint exists",
    status: "PRESERVED",
  },
  {
    legacy: "manual compact returns false when compaction is disabled",
    migratedAs:
      "ADAPTED: compact returns a failure result when compaction is disabled",
    status: "ADAPTED",
  },
  {
    legacy: "manual compact returns false when no messages",
    migratedAs:
      "ADAPTED: compact returns a failure result for empty and single-message histories",
    status: "ADAPTED",
  },
  {
    legacy: "uses custom summarize function when provided",
    migratedAs: "PRESERVED: uses a custom summarize function when provided",
    status: "PRESERVED",
  },
  {
    legacy: "preserves recent messages based on keepRecentTokens",
    migratedAs:
      "PRESERVED: preserves recent messages based on keepRecentTokens",
    status: "PRESERVED",
  },
  {
    legacy: "getEstimatedTokens returns 0 for empty history",
    migratedAs: "PRESERVED: getEstimatedTokens returns 0 for empty history",
    status: "PRESERVED",
  },
  {
    legacy: "getEstimatedTokens increases with message count",
    migratedAs: "PRESERVED: getEstimatedTokens increases with message count",
    status: "PRESERVED",
  },
  {
    legacy: "includes summaries in estimated token count",
    migratedAs:
      "ADAPTED: compact reports token counts that stay consistent with active history",
    status: "ADAPTED",
  },
  {
    legacy: "getMessagesForLLM prepends summaries as system message",
    migratedAs:
      "ADAPTED: compact reports token counts that stay consistent with active history",
    status: "ADAPTED",
  },
  {
    legacy: "clears summaries when clear() is called",
    reason:
      "CheckpointHistory no longer exposes clear(); sessions remain append-only.",
    status: "OBSOLETED",
  },
  {
    legacy: "handles concurrent compaction calls gracefully",
    migratedAs:
      "ADAPTED: CompactionOrchestrator rejects concurrent manual compactions",
    status: "ADAPTED",
  },
  ...[
    "skips pruning during intermediate steps",
    "compacts earlier during intermediate steps",
    "respects maxMessages even with compaction enabled",
  ].map(
    (legacy) =>
      ({
        legacy,
        reason:
          legacy === "respects maxMessages even with compaction enabled"
            ? "CheckpointHistory removed maxMessages trimming."
            : "Phase-aware pruning and speculative timing moved into policy/orchestrator layers.",
        status: "OBSOLETED",
      }) satisfies LegacyTestClassification
  ),
  {
    legacy:
      "never leaves a tool role message as the first message after enforceLimit",
    migratedAs:
      "PRESERVED: never surfaces a tool result as the first active message",
    status: "PRESERVED",
  },
  {
    legacy:
      "removes orphaned tool_result when fallback slice starts with a tool message",
    migratedAs:
      "PRESERVED: removes orphaned tool results without a preceding assistant tool-call",
    status: "PRESERVED",
  },
  {
    legacy:
      "removes all tool messages when only tool_result messages remain after trim",
    migratedAs:
      "PRESERVED: removes orphaned tool results without a preceding assistant tool-call",
    status: "PRESERVED",
  },
  {
    legacy:
      "preserves valid tool_call and tool_result pair when both fit within the limit",
    migratedAs: "PRESERVED: preserves a valid assistant/tool pair",
    status: "PRESERVED",
  },
  ...[
    "starts with no actual usage",
    "stores usage after updateActualUsage",
    "computes totalTokens from prompt+completion when not provided",
    "accepts AI SDK inputTokens/outputTokens usage shape",
    "defaults to 0 for undefined fields",
    "clears actual usage on clear()",
    "returns null when contextLimit is not set",
    "returns estimated usage when no actual usage available",
    "returns actual usage when available",
    "clamps percentage to 100",
    "uses actual usage for needsCompaction when available",
    "falls back to estimated when no actual usage or contextLimit",
    "applies intermediate-step multiplier to reserve with actual usage",
    "invalidates actual usage after message mutations",
    "adjusts actual usage downward after compaction",
  ].map(
    (legacy) =>
      ({
        legacy,
        reason:
          "Actual-usage accounting and context policy calculations moved out of CheckpointHistory.",
        status: "OBSOLETED",
      }) satisfies LegacyTestClassification
  ),
  {
    legacy: "prepares speculative compaction without mutating live history",
    migratedAs:
      "ADAPTED: speculative compaction leaves live history unchanged while summarization is still running",
    status: "ADAPTED",
  },
  {
    legacy:
      "drops prepared compaction when the live history no longer matches the base snapshot",
    migratedAs:
      "ADAPTED: speculative compaction is marked stale after the history changes",
    status: "ADAPTED",
  },
  {
    legacy: "applies prepared compaction when the live revision matches",
    migratedAs:
      "ADAPTED: speculative compaction is accepted when the history is unchanged",
    status: "ADAPTED",
  },
  {
    legacy: "applies prepared compaction across append-only message growth",
    reason:
      "The new speculative path treats post-start mutations as stale instead of merging append-only tails.",
    status: "OBSOLETED",
  },
  ...[
    "predicts speculative compaction one turn early",
    "uses speculativeStartRatio when configured",
    "can start speculative compaction proactively even after pendingCompaction was cleared",
    "detects whether an additional message would exceed the context limit",
    "returns false when both compaction and pruning are disabled",
    "returns true when totalTokens + reserveTokens >= contextLimit",
    "returns false when totalTokens + reserveTokens < contextLimit",
    "adds additionalTokens parameter to the check",
    "uses reserveTokens * 2 for intermediate-step phase",
    "returns true in pruning-only mode when at limit",
    "subtracts reserve tokens from the output budget",
    "returns zero when the estimated input plus reserve already exhausts the limit",
    "returns a smaller budget when reserve tokens are configured",
    "prepareSpeculativeCompaction sets contextLimitAtCreation and compactionMaxTokensAtCreation",
    "applyPreparedCompaction rejects stale compaction when setContextLimit changes",
    "applyPreparedCompaction rejects stale compaction when updateCompaction changes maxTokens",
    "applyPreparedCompaction rejects stale compaction when keepRecentTokens changes",
    "getMessagesForLLMAsync does not call summarizeFn (neutered)",
    "clamps to floor for small contexts with no reserve",
    "returns reserve-aware ratio for medium contexts",
    "clamps to maximum for large contexts with small reserve",
    "produces lower ratios when reserve is large",
    "guarantees speculative fires before hard compaction",
    "handles edge cases",
    "monotonically increases with context length (fixed reserve)",
    "handles extreme reserve (85% of context)",
    "handles reserve = contextLength - 1",
    "normalizes negative reserveTokens to 0",
    "clamps ratio strictly below hard threshold (boundary equality defense)",
  ].map(
    (legacy) =>
      ({
        legacy,
        reason:
          "These threshold and reserve heuristics now belong to compaction-policy or orchestrator-level tests.",
        status: "OBSOLETED",
      }) satisfies LegacyTestClassification
  ),
  {
    legacy:
      "applyPreparedCompaction applies successfully when no config changes",
    migratedAs:
      "ADAPTED: speculative compaction is accepted when the history is unchanged",
    status: "ADAPTED",
  },
  ...[
    "does not return orphaned tool messages when budget is extremely small",
    "does not return dangling assistant tool-calls after extreme truncation",
  ].map(
    (legacy) =>
      ({
        legacy,
        migratedAs:
          "ADAPTED: overflow recovery does not expose orphaned tool messages after truncation",
        status: "ADAPTED",
      }) satisfies LegacyTestClassification
  ),
  ...[
    "returns empty array when budget allows nothing and last message is tool",
    "preserves the last valid tool pair when zero-budget truncation would otherwise empty the request",
    "tracks raw message segments as messages are added",
    "rebuilds segments after compaction",
  ].map(
    (legacy) =>
      ({
        legacy,
        reason: legacy.includes("segments")
          ? "Checkpoint pointers replaced the old segment model."
          : "getMessagesForLLM no longer performs zero-budget request truncation.",
        status: "OBSOLETED",
      }) satisfies LegacyTestClassification
  ),
] as const satisfies readonly LegacyTestClassification[];

if (LEGACY_MESSAGE_HISTORY_CLASSIFICATIONS.length !== 100) {
  throw new Error(
    `Expected 100 legacy MessageHistory test classifications, received ${LEGACY_MESSAGE_HISTORY_CLASSIFICATIONS.length}`
  );
}

const toolCallPart: ToolCallPart = {
  type: "tool-call",
  toolCallId: "call_123",
  toolName: "shell_command",
  input: { command: 'git commit -m "test"' },
};

function getStoredMessages(history: CheckpointHistory): ModelMessage[] {
  return history.toModelMessages();
}

function createCompactionHistory(
  summarizeFn: () => Promise<string> = async () => "Conversation summary"
): CheckpointHistory {
  return new CheckpointHistory({
    compaction: {
      enabled: true,
      contextLimit: 120,
      keepRecentTokens: 20,
      maxTokens: 120,
      reserveTokens: 10,
      summarizeFn,
    },
  });
}

describe("CheckpointHistory edge cases", () => {
  it("ADAPTED/PRESERVED: trims assistant string content when storing model messages", () => {
    const history = new CheckpointHistory();

    history.addModelMessages([
      {
        role: "assistant",
        content: "Saved without trailing newlines\n\n",
      },
      {
        role: "assistant",
        content: "Already trimmed",
      },
    ]);

    expect(getStoredMessages(history)).toEqual([
      {
        role: "assistant",
        content: "Saved without trailing newlines",
      },
      {
        role: "assistant",
        content: "Already trimmed",
      },
    ]);
  });

  it("ADAPTED: trims the last assistant text part while preserving tool-call parts", () => {
    const history = new CheckpointHistory();

    history.addModelMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll commit this.\n\n\n" },
          toolCallPart,
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_123",
            toolName: "shell_command",
            output: { type: "text", value: "ok" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            ...toolCallPart,
            toolCallId: "call_456",
          },
          { type: "text", text: "Done\n\n" },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_456",
            toolName: "shell_command",
            output: { type: "text", value: "done" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            ...toolCallPart,
            toolCallId: "call_789",
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_789",
            toolName: "shell_command",
            output: { type: "text", value: "still ok" },
          },
        ],
      },
      {
        role: "assistant",
        content: [],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "No newlines" }],
      },
    ]);

    const messages = getStoredMessages(history);
    expect(messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "I'll commit this." }, toolCallPart],
    });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: [
        {
          ...toolCallPart,
          toolCallId: "call_456",
        },
        { type: "text", text: "Done" },
      ],
    });
    expect(messages[4]).toEqual({
      role: "assistant",
      content: [
        {
          ...toolCallPart,
          toolCallId: "call_789",
        },
      ],
    });
    expect(messages[6]).toEqual({ role: "assistant", content: [] });
    expect(messages[7]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "No newlines" }],
    });
  });

  it("PRESERVED: stores originalContent for translated user messages", () => {
    const history = new CheckpointHistory();
    const message = history.addUserMessage(
      "Please update workspace/foo.ts",
      "workspace/foo.ts 파일을 수정해줘"
    );

    expect(message.message.content).toBe("Please update workspace/foo.ts");
    expect(message.originalContent).toBe("workspace/foo.ts 파일을 수정해줘");
  });

  it("PRESERVED: keeps originalContent undefined for English user messages", () => {
    const history = new CheckpointHistory();
    const message = history.addUserMessage("Please list the files");

    expect(message.message.content).toBe("Please list the files");
    expect(message.originalContent).toBeUndefined();
  });

  it("PRESERVED: is disabled by default", () => {
    const history = new CheckpointHistory();
    expect(history.getCompactionConfig().enabled).toBe(false);
  });

  it("PRESERVED: can be enabled via options", () => {
    const history = new CheckpointHistory({
      compaction: { enabled: true },
    });
    expect(history.getCompactionConfig().enabled).toBe(true);
  });

  it("ADAPTED: starts without a checkpoint regardless of compaction config", () => {
    expect(new CheckpointHistory().getSummaryMessageId()).toBeNull();
    expect(
      new CheckpointHistory({
        compaction: { enabled: true },
      }).getSummaryMessageId()
    ).toBeNull();
  });

  it("PRESERVED: getMessagesForLLM returns plain messages when no checkpoint exists", () => {
    const history = new CheckpointHistory({
      compaction: { enabled: true },
    });
    history.addUserMessage("Hello");
    history.addModelMessages([{ role: "assistant", content: "Hi there" }]);

    expect(history.getMessagesForLLM()).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
  });

  it("ADAPTED: compact returns a failure result when compaction is disabled", async () => {
    const history = new CheckpointHistory();
    history.addUserMessage("Hello");

    await expect(history.compact()).resolves.toEqual({
      success: false,
      tokensBefore: 0,
      tokensAfter: 0,
      reason: "compaction disabled",
    });
  });

  it("ADAPTED: compact returns a failure result for empty and single-message histories", async () => {
    const emptyHistory = new CheckpointHistory({
      compaction: { enabled: true, summarizeFn: async () => "summary" },
    });

    await expect(emptyHistory.compact()).resolves.toEqual({
      success: false,
      tokensBefore: 0,
      tokensAfter: 0,
      reason: "no messages",
    });

    const singleMessageHistory = new CheckpointHistory({
      compaction: { enabled: true, summarizeFn: async () => "summary" },
    });
    singleMessageHistory.addUserMessage("only message");

    await expect(singleMessageHistory.compact()).resolves.toEqual({
      success: false,
      tokensBefore: singleMessageHistory.getEstimatedTokens(),
      tokensAfter: singleMessageHistory.getEstimatedTokens(),
      reason: "no messages to summarize",
    });
  });

  it("PRESERVED: uses a custom summarize function when provided", async () => {
    let callCount = 0;
    const history = createCompactionHistory(() => {
      callCount += 1;
      return Promise.resolve("Custom summary");
    });

    history.addUserMessage("x".repeat(120));
    history.addUserMessage("y".repeat(120));

    const result = await history.compact();
    expect(result.success).toBe(true);
    expect(callCount).toBe(1);
    expect(history.getMessagesForLLM()[0]).toEqual({
      role: "user",
      content: "Custom summary",
    });
  });

  it("PRESERVED: preserves recent messages based on keepRecentTokens", async () => {
    const history = createCompactionHistory(() =>
      Promise.resolve("Older context summary")
    );

    history.addUserMessage("older request ".repeat(20));
    history.addModelMessages([
      { role: "assistant", content: "older response ".repeat(20) },
    ]);
    history.addUserMessage("recent message to keep");
    history.addModelMessages([
      { role: "assistant", content: "recent response" },
    ]);

    const result = await history.compact();
    expect(result.success).toBe(true);

    const contents = history
      .getMessagesForLLM()
      .flatMap((message) =>
        typeof message.content === "string" ? [message.content] : []
      );

    expect(contents).toContain("recent message to keep");
    expect(contents).toContain("recent response");
  });

  it("PRESERVED: getEstimatedTokens returns 0 for empty history", () => {
    expect(
      new CheckpointHistory({
        compaction: { enabled: true },
      }).getEstimatedTokens()
    ).toBe(0);
  });

  it("PRESERVED: getEstimatedTokens increases with message count", () => {
    const history = new CheckpointHistory({ compaction: { enabled: true } });

    const tokensBefore = history.getEstimatedTokens();
    history.addUserMessage("This is a test message with some content");
    const tokensAfter = history.getEstimatedTokens();

    expect(tokensAfter).toBeGreaterThan(tokensBefore);
  });

  it("ADAPTED: compact reports token counts that stay consistent with active history", async () => {
    const history = createCompactionHistory(() =>
      Promise.resolve("Conversation summary\n\n")
    );

    history.addUserMessage(
      "Message one with enough text to count and exceed limits"
    );
    history.addModelMessages([
      {
        role: "assistant",
        content: "Response one with content that is long enough",
      },
    ]);
    history.addUserMessage(
      "Message two with enough text to count and exceed limits"
    );
    history.addModelMessages([
      {
        role: "assistant",
        content: "Response two with content that is long enough",
      },
    ]);

    const tokensBefore = history.getEstimatedTokens();
    const result = await history.compact();

    expect(result.success).toBe(true);
    expect(result.tokensBefore).toBe(tokensBefore);
    expect(result.tokensAfter).toBe(history.getEstimatedTokens());
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(history.getMessagesForLLM()[0]).toEqual({
      role: "user",
      content: "Conversation summary",
    });
  });

  it("ADAPTED: CompactionOrchestrator rejects concurrent manual compactions", async () => {
    let resolveSummary: ((summary: string) => void) | undefined;
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        summarizeFn: () =>
          new Promise<string>((resolve) => {
            resolveSummary = resolve;
          }),
      },
    });
    history.addUserMessage("hello");
    history.addModelMessages([{ role: "assistant", content: "world" }]);

    const orchestrator = new CompactionOrchestrator(history);
    const first = orchestrator.manualCompact();
    const second = await orchestrator.manualCompact();

    expect(second.success).toBe(false);
    expect(second.reason).toContain("in progress");

    resolveSummary?.("Summary");
    await first;
  });

  it("PRESERVED: never surfaces a tool result as the first active message", () => {
    const history = new CheckpointHistory();

    history.addModelMessages([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read_file",
            output: { type: "text", value: "file contents" },
          },
        ],
      },
    ]);

    expect(history.getMessagesForLLM()).toEqual([]);
  });

  it("PRESERVED: removes orphaned tool results without a preceding assistant tool-call", () => {
    const history = new CheckpointHistory();

    history.addModelMessages([
      { role: "user", content: "initial" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read_file",
            output: { type: "text", value: "file contents" },
          },
        ],
      },
    ]);

    expect(history.getMessagesForLLM()).toEqual([
      { role: "user", content: "initial" },
    ]);
  });

  it("PRESERVED: preserves a valid assistant/tool pair", () => {
    const history = new CheckpointHistory();

    history.addUserMessage("initial");
    history.addModelMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_3",
            toolName: "read_file",
            input: { path: "src/index.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_3",
            toolName: "read_file",
            output: {
              type: "text",
              value: "export default function main() {}",
            },
          },
        ],
      },
    ]);

    expect(history.getMessagesForLLM()).toEqual([
      { role: "user", content: "initial" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_3",
            toolName: "read_file",
            input: { path: "src/index.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_3",
            toolName: "read_file",
            output: {
              type: "text",
              value: "export default function main() {}",
            },
          },
        ],
      },
    ]);
  });

  it("ADAPTED: speculative compaction leaves live history unchanged while summarization is still running", async () => {
    let resolveSummary: ((summary: string) => void) | undefined;
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 80,
        keepRecentTokens: 10,
        maxTokens: 10,
        reserveTokens: 0,
        summarizeFn: () =>
          new Promise<string>((resolve) => {
            resolveSummary = resolve;
          }),
      },
    });

    for (let index = 0; index < 8; index += 1) {
      history.addUserMessage(`long message ${index} that should compact soon`);
    }

    const before = history.getAll().map((message) => message.id);
    const orchestrator = new CompactionOrchestrator(history);
    expect(orchestrator.shouldStartSpeculative()).toBe(true);

    orchestrator.startSpeculative();
    expect(history.getAll().map((message) => message.id)).toEqual(before);

    resolveSummary?.("Summary");
    await orchestrator.getLatestRunningSpeculativeCompaction()?.promise;
  });

  it("ADAPTED: speculative compaction is marked stale after the history changes", async () => {
    let resolveSummary: ((summary: string) => void) | undefined;
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 80,
        keepRecentTokens: 10,
        maxTokens: 10,
        reserveTokens: 0,
        summarizeFn: () =>
          new Promise<string>((resolve) => {
            resolveSummary = resolve;
          }),
      },
    });

    for (let index = 0; index < 8; index += 1) {
      history.addUserMessage(`long message ${index} that should compact soon`);
    }

    const orchestrator = new CompactionOrchestrator(history);
    orchestrator.startSpeculative();
    history.addUserMessage("mutation while speculative compaction runs");
    resolveSummary?.("Summary");
    await orchestrator.getLatestRunningSpeculativeCompaction()?.promise;

    expect(orchestrator.applyReady()).toEqual({ applied: true, stale: true });
  });

  it("ADAPTED: speculative compaction is accepted when the history is unchanged", async () => {
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 200,
        keepRecentTokens: 10,
        maxTokens: 10,
        reserveTokens: 0,
        summarizeFn: async () => "Summary",
      },
    });

    for (let index = 0; index < 20; index += 1) {
      history.addUserMessage(`long message ${index} that should compact soon`);
    }

    const orchestrator = new CompactionOrchestrator(history);
    orchestrator.startSpeculative();
    await orchestrator.getLatestRunningSpeculativeCompaction()?.promise;

    expect(orchestrator.applyReady()).toEqual({ applied: true, stale: false });
  });

  it("metadata-only revision bump does not make speculative compaction stale", async () => {
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 200,
        keepRecentTokens: 10,
        maxTokens: 10,
        reserveTokens: 0,
        summarizeFn: async () => "Summary",
      },
    });

    for (let index = 0; index < 20; index += 1) {
      history.addUserMessage(`long message ${index} that should compact soon`);
    }

    const orchestrator = new CompactionOrchestrator(history);
    orchestrator.startSpeculative();
    await orchestrator.getLatestRunningSpeculativeCompaction()?.promise;

    history.updateActualUsage({ inputTokens: 100, outputTokens: 50 });
    history.setContextLimit(200);
    history.setSystemPromptTokens(500);

    expect(orchestrator.applyReady()).toEqual({ applied: true, stale: false });
  });

  it("stale speculative compaction still emits onCompactionComplete callback", async () => {
    let resolveSummary: ((summary: string) => void) | undefined;
    const onComplete = vi.fn();
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 80,
        keepRecentTokens: 10,
        maxTokens: 10,
        reserveTokens: 0,
        summarizeFn: () =>
          new Promise<string>((resolve) => {
            resolveSummary = resolve;
          }),
      },
    });

    for (let index = 0; index < 8; index += 1) {
      history.addUserMessage(`long message ${index} that should compact soon`);
    }

    const orchestrator = new CompactionOrchestrator(history, {
      onCompactionComplete: onComplete,
    });
    orchestrator.startSpeculative();
    history.addUserMessage("mutation while speculative runs");
    resolveSummary?.("Summary");
    await orchestrator.getLatestRunningSpeculativeCompaction()?.promise;

    const result = orchestrator.applyReady();
    expect(result).toEqual({ applied: true, stale: true });
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("concurrent message append during summarize downgrades replay to tool-loop", async () => {
    let resolveSummary: ((summary: string) => void) | undefined;
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 80,
        keepRecentTokens: 10,
        maxTokens: 10,
        reserveTokens: 0,
        summarizeFn: () =>
          new Promise<string>((resolve) => {
            resolveSummary = resolve;
          }),
      },
    });

    history.addUserMessage("original request");
    for (let index = 0; index < 7; index += 1) {
      history.addUserMessage(`filler message ${index}`);
    }

    const compactPromise = history.compact({ auto: true });

    history.addUserMessage("new message during summarize");
    resolveSummary?.("Summary");

    const result = await compactPromise;

    expect(result.success).toBe(true);
    expect(result.continuationVariant).toBe("tool-loop");

    const allMessages = history.getAll();
    const replayedOriginals = allMessages.filter(
      (m) =>
        m.message.role === "user" && m.message.content === "original request"
    );
    expect(replayedOriginals.length).toBe(1);
  });

  it("compact with no concurrent changes uses auto-with-replay", async () => {
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 80,
        keepRecentTokens: 10,
        maxTokens: 10,
        reserveTokens: 0,
        summarizeFn: async () => "Summary",
      },
    });

    for (let index = 0; index < 8; index += 1) {
      history.addUserMessage(`message ${index}`);
    }

    const result = await history.compact({ auto: true });
    expect(result.success).toBe(true);
    expect(result.continuationVariant).toBe("auto-with-replay");
  });

  it("messageRevision only increments on message mutations, not metadata", () => {
    const history = new CheckpointHistory({
      compaction: { enabled: true, contextLimit: 100 },
    });

    const rev0 = history.getMessageRevision();
    history.addUserMessage("hello");
    const rev1 = history.getMessageRevision();
    expect(rev1).toBe(rev0 + 1);

    history.updateActualUsage({ inputTokens: 100 });
    expect(history.getMessageRevision()).toBe(rev1);

    history.setContextLimit(200);
    expect(history.getMessageRevision()).toBe(rev1);

    history.setSystemPromptTokens(50);
    expect(history.getMessageRevision()).toBe(rev1);

    history.updateCompaction({ maxTokens: 5000 });
    expect(history.getMessageRevision()).toBe(rev1);

    history.updatePruning({ enabled: true });
    expect(history.getMessageRevision()).toBe(rev1);

    history.addModelMessages([{ role: "assistant", content: "world" }]);
    expect(history.getMessageRevision()).toBe(rev1 + 1);

    history.clear();
    expect(history.getMessageRevision()).toBe(rev1 + 2);
  });

  it("addModelMessages with empty array does not bump messageRevision", () => {
    const history = new CheckpointHistory({
      compaction: { enabled: true, contextLimit: 100 },
    });

    history.addUserMessage("hello");
    const revBefore = history.getMessageRevision();

    history.addModelMessages([]);
    expect(history.getMessageRevision()).toBe(revBefore);
  });

  it("compactForOverflowRecovery rollback restores messageRevision", async () => {
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 10,
        reserveTokens: 0,
        summarizeFn: async () => "a".repeat(5000),
      },
    });

    history.addUserMessage("short");
    history.addUserMessage("msg2");
    const revBefore = history.getMessageRevision();

    await history.handleContextOverflow();
    const revAfter = history.getMessageRevision();
    expect(revAfter).toBeGreaterThanOrEqual(revBefore);
  });

  it("ADAPTED: overflow recovery does not expose orphaned tool messages after truncation", async () => {
    const history = new CheckpointHistory({
      compaction: {
        enabled: true,
        contextLimit: 40,
      },
    });

    history.addUserMessage("Hello");
    history.addModelMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "test_tool",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "test_tool",
            output: { type: "text", value: "output".repeat(20) },
          },
        ],
      },
    ]);

    const result = await history.handleContextOverflow();
    expect(result.tokensAfter).toBeLessThanOrEqual(result.tokensBefore);

    const messages = history.getMessagesForLLM();
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role === "tool") {
        expect(index).toBeGreaterThan(0);
        expect(messages[index - 1]?.role).toBe("assistant");
      }
      if (
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "tool-call")
      ) {
        expect(messages[index + 1]?.role).toBe("tool");
      }
    }
  });
});
