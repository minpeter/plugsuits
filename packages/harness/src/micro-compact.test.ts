import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckpointMessage } from "./compaction-types";
import { microCompactMessages } from "./micro-compact";
import { estimateTokens, extractMessageText } from "./token-utils";

let checkpointId = 0;

function makeCheckpoint(
  message: ModelMessage,
  options: { isSummary?: boolean } = {}
): CheckpointMessage {
  checkpointId += 1;

  return {
    createdAt: 1_700_000_000_000 + checkpointId,
    id: `checkpoint_${checkpointId}`,
    isSummary: options.isSummary ?? false,
    message,
  };
}

function makeAssistantMessage(
  text: string,
  options: { isSummary?: boolean } = {}
): CheckpointMessage {
  return makeCheckpoint(
    {
      role: "assistant",
      content: text,
    },
    options
  );
}

function makeUserMessage(text: string): CheckpointMessage {
  return makeCheckpoint({ role: "user", content: text });
}

interface LegacyToolResultPart {
  content: unknown;
  name?: string;
  tool_use_id: string;
  type: "tool_result";
}

function makeUserToolResultMessage(
  toolResults: LegacyToolResultPart[]
): CheckpointMessage {
  return makeCheckpoint({
    role: "user",
    content: toolResults.map((part) => ({
      ...part,
    })),
  } as unknown as ModelMessage);
}

function getLegacyToolResultPart(
  message: ModelMessage,
  partIndex = 0
): LegacyToolResultPart | null {
  const content = message.content as unknown;
  if (!Array.isArray(content)) {
    return null;
  }

  const part = content[partIndex];
  if (
    typeof part !== "object" ||
    part === null ||
    !("type" in part) ||
    part.type !== "tool_result" ||
    !("tool_use_id" in part) ||
    typeof part.tool_use_id !== "string" ||
    !("content" in part)
  ) {
    return null;
  }

  return part as LegacyToolResultPart;
}

function makeTokenSizedText(tokens: number): string {
  return "x".repeat(tokens * 4);
}

function estimateCheckpointTokens(messages: CheckpointMessage[]): number {
  return messages.reduce(
    (total, checkpoint) =>
      total + estimateTokens(extractMessageText(checkpoint.message)),
    0
  );
}

describe("microCompactMessages", () => {
  beforeEach(() => {
    checkpointId = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("no-op when all messages are recent", () => {
    const oldAssistant = makeAssistantMessage(makeTokenSizedText(900));
    const recentUser = makeUserMessage(makeTokenSizedText(200));
    const messages: CheckpointMessage[] = [oldAssistant, recentUser];

    const result = microCompactMessages(messages, {
      protectRecentTokens: 100_000,
    });

    expect(result.messages).not.toBe(messages);
    expect(result.messages).toEqual(messages);
    expect(result.tokensSaved).toBe(0);
    expect(result.messagesModified).toBe(0);
  });

  it("shrinks old long assistant response", () => {
    const oldAssistantText = makeTokenSizedText(900);
    const recentUserText = makeTokenSizedText(250);
    const messages: CheckpointMessage[] = [
      makeAssistantMessage(oldAssistantText),
      makeUserMessage(recentUserText),
    ];

    const result = microCompactMessages(messages, {
      protectRecentTokens: estimateTokens(recentUserText) + 1,
      maxResponseTokens: 500,
      minSavingsTokens: 1,
    });

    const rewrittenText = extractMessageText(result.messages[0].message);

    expect(result.messagesModified).toBe(1);
    expect(estimateTokens(oldAssistantText)).toBeGreaterThan(500);
    expect(estimateTokens(rewrittenText)).toBeLessThan(
      estimateTokens(oldAssistantText)
    );
    expect(rewrittenText).toContain("[response shrunk —");
  });

  it("preserves user messages", () => {
    const preservedUserText = makeTokenSizedText(850);
    const oldAssistantText = makeTokenSizedText(900);
    const recentUserText = makeTokenSizedText(220);
    const messages: CheckpointMessage[] = [
      makeUserMessage(preservedUserText),
      makeAssistantMessage(oldAssistantText),
      makeUserMessage(recentUserText),
    ];

    const result = microCompactMessages(messages, {
      protectRecentTokens: estimateTokens(recentUserText) + 1,
      maxResponseTokens: 500,
      minSavingsTokens: 1,
    });

    expect(result.messagesModified).toBe(1);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[0].message).toEqual(messages[0].message);
  });

  it("preserves summary messages", () => {
    const summaryText = makeTokenSizedText(900);
    const recentUserText = makeTokenSizedText(240);
    const messages: CheckpointMessage[] = [
      makeAssistantMessage(summaryText, { isSummary: true }),
      makeUserMessage(recentUserText),
    ];

    const result = microCompactMessages(messages, {
      protectRecentTokens: estimateTokens(recentUserText) + 1,
      maxResponseTokens: 500,
      minSavingsTokens: 1,
    });

    expect(result.messagesModified).toBe(0);
    expect(result.tokensSaved).toBe(0);
    expect(result.messages[0]).toBe(messages[0]);
    expect(extractMessageText(result.messages[0].message)).toBe(summaryText);
  });

  it("respects protectRecentTokens", () => {
    const oldAssistantText = makeTokenSizedText(900);
    const recentAssistantText = makeTokenSizedText(900);
    const messages: CheckpointMessage[] = [
      makeAssistantMessage(oldAssistantText),
      makeAssistantMessage(recentAssistantText),
    ];

    const result = microCompactMessages(messages, {
      protectRecentTokens: estimateTokens(recentAssistantText) + 10,
      maxResponseTokens: 500,
      minSavingsTokens: 1,
    });

    expect(result.messagesModified).toBe(1);
    expect(extractMessageText(result.messages[0].message)).toContain(
      "[response shrunk —"
    );
    expect(extractMessageText(result.messages[1].message)).toBe(
      recentAssistantText
    );
  });

  it("respects minSavingsTokens threshold", () => {
    const oldAssistantText = makeTokenSizedText(900);
    const recentUserText = makeTokenSizedText(210);
    const messages: CheckpointMessage[] = [
      makeAssistantMessage(oldAssistantText),
      makeUserMessage(recentUserText),
    ];

    const result = microCompactMessages(messages, {
      protectRecentTokens: estimateTokens(recentUserText) + 1,
      maxResponseTokens: 500,
      minSavingsTokens: 100_000,
    });

    expect(result.messagesModified).toBe(0);
    expect(result.tokensSaved).toBe(0);
    expect(result.messages[0]).toBe(messages[0]);
  });

  it("returns correct tokensSaved and messagesModified counts", () => {
    const firstOldAssistant = makeTokenSizedText(920);
    const secondOldAssistant = makeTokenSizedText(880);
    const recentUserText = makeTokenSizedText(230);

    const messages: CheckpointMessage[] = [
      makeAssistantMessage(firstOldAssistant),
      makeAssistantMessage(secondOldAssistant),
      makeUserMessage(recentUserText),
    ];

    const tokensBefore = estimateCheckpointTokens(messages);

    const result = microCompactMessages(messages, {
      protectRecentTokens: estimateTokens(recentUserText) + 1,
      maxResponseTokens: 500,
      minSavingsTokens: 1,
    });

    const tokensAfter = estimateCheckpointTokens(result.messages);

    expect(result.messagesModified).toBe(2);
    expect(result.tokensSaved).toBe(tokensBefore - tokensAfter);
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  it("clearToolResults=false keeps tool_result content intact", () => {
    const oldToolResultText = makeTokenSizedText(500);
    const recentUserText = makeTokenSizedText(250);
    const messages: CheckpointMessage[] = [
      makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          name: "read_file",
          content: oldToolResultText,
        },
      ]),
      makeUserMessage(recentUserText),
    ];

    const result = microCompactMessages(messages, {
      protectRecentTokens: estimateTokens(recentUserText) + 1,
      keepRecentToolResults: 0,
    });

    const part = getLegacyToolResultPart(result.messages[0].message);
    expect(part?.content).toBe(oldToolResultText);
    expect(result.toolResultsCleared).toBe(0);
    expect(result.messagesModified).toBe(0);
  });

  it("clearOlderThanMs clears stale tool results without clearToolResults", () => {
    vi.useFakeTimers();
    const now = 1_800_000_000_000;
    vi.setSystemTime(now);

    const staleResult = makeTokenSizedText(500);
    const recentResult = makeTokenSizedText(500);
    const staleMessage: CheckpointMessage = {
      ...makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          name: "read_file",
          content: staleResult,
        },
      ]),
      createdAt: now - 10_000,
    };
    const recentMessage: CheckpointMessage = {
      ...makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_2",
          name: "read_file",
          content: recentResult,
        },
      ]),
      createdAt: now - 500,
    };

    const result = microCompactMessages([staleMessage, recentMessage], {
      clearOlderThanMs: 1000,
      keepRecentToolResults: 2,
      protectRecentTokens: 0,
    });

    expect(getLegacyToolResultPart(result.messages[0].message)?.content).toBe(
      "[tool result cleared]"
    );
    expect(getLegacyToolResultPart(result.messages[1].message)?.content).toBe(
      recentResult
    );
    expect(result.toolResultsCleared).toBe(1);
    expect(result.messagesModified).toBe(1);
  });

  it("clearOlderThanMs adds to keepRecentToolResults-based clearing", () => {
    vi.useFakeTimers();
    const now = 1_800_000_000_000;
    vi.setSystemTime(now);

    const firstResult = makeTokenSizedText(500);
    const secondResult = makeTokenSizedText(500);
    const firstMessage: CheckpointMessage = {
      ...makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          name: "read_file",
          content: firstResult,
        },
      ]),
      createdAt: now - 15_000,
    };
    const secondMessage: CheckpointMessage = {
      ...makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_2",
          name: "read_file",
          content: secondResult,
        },
      ]),
      createdAt: now - 12_000,
    };

    const result = microCompactMessages([firstMessage, secondMessage], {
      clearToolResults: true,
      clearOlderThanMs: 1000,
      keepRecentToolResults: 1,
      protectRecentTokens: 0,
    });

    expect(getLegacyToolResultPart(result.messages[0].message)?.content).toBe(
      "[tool result cleared]"
    );
    expect(getLegacyToolResultPart(result.messages[1].message)?.content).toBe(
      "[tool result cleared]"
    );
    expect(result.toolResultsCleared).toBe(2);
    expect(result.messagesModified).toBe(2);
  });

  it("clearToolResults=true clears old tool results", () => {
    const oldToolResultText = makeTokenSizedText(500);
    const recentUserText = makeTokenSizedText(260);
    const messages: CheckpointMessage[] = [
      makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          name: "read_file",
          content: oldToolResultText,
        },
      ]),
      makeUserMessage(recentUserText),
    ];

    const result = microCompactMessages(messages, {
      clearToolResults: true,
      keepRecentToolResults: 0,
      protectRecentTokens: estimateTokens(recentUserText) + 1,
    });

    const part = getLegacyToolResultPart(result.messages[0].message);
    expect(part).not.toBeNull();
    expect(part?.tool_use_id).toBe("tool_1");
    expect(part?.content).toBe("[tool result cleared]");
    expect(result.toolResultsCleared).toBe(1);
    expect(result.messagesModified).toBe(1);
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  it("keepRecentToolResults preserves most recent tool results", () => {
    const first = makeTokenSizedText(450);
    const second = makeTokenSizedText(450);
    const third = makeTokenSizedText(450);
    const messages: CheckpointMessage[] = [
      makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          name: "read_file",
          content: first,
        },
      ]),
      makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_2",
          name: "read_file",
          content: second,
        },
      ]),
      makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_3",
          name: "read_file",
          content: third,
        },
      ]),
    ];

    const result = microCompactMessages(messages, {
      clearToolResults: true,
      keepRecentToolResults: 2,
      protectRecentTokens: 0,
    });

    expect(getLegacyToolResultPart(result.messages[0].message)?.content).toBe(
      "[tool result cleared]"
    );
    expect(getLegacyToolResultPart(result.messages[1].message)?.content).toBe(
      second
    );
    expect(getLegacyToolResultPart(result.messages[2].message)?.content).toBe(
      third
    );
    expect(result.toolResultsCleared).toBe(1);
  });

  it("clearableToolNames clears only matching tool names", () => {
    const readFileResult = makeTokenSizedText(450);
    const grepResult = makeTokenSizedText(450);
    const messages: CheckpointMessage[] = [
      makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          name: "read_file",
          content: readFileResult,
        },
      ]),
      makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_2",
          name: "grep",
          content: grepResult,
        },
      ]),
    ];

    const result = microCompactMessages(messages, {
      clearToolResults: true,
      clearableToolNames: ["read_file"],
      keepRecentToolResults: 0,
      protectRecentTokens: 0,
    });

    expect(getLegacyToolResultPart(result.messages[0].message)?.content).toBe(
      "[tool result cleared]"
    );
    expect(getLegacyToolResultPart(result.messages[1].message)?.content).toBe(
      grepResult
    );
    expect(result.toolResultsCleared).toBe(1);
  });

  it("uses custom tool result replacement text", () => {
    const customReplacement = "[Old tool result content cleared]";
    const oldToolResultText = makeTokenSizedText(480);
    const messages: CheckpointMessage[] = [
      makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          name: "read_file",
          content: oldToolResultText,
        },
      ]),
    ];

    const result = microCompactMessages(messages, {
      clearToolResults: true,
      keepRecentToolResults: 0,
      protectRecentTokens: 0,
      toolResultReplacementText: customReplacement,
    });

    expect(getLegacyToolResultPart(result.messages[0].message)?.content).toBe(
      customReplacement
    );
    expect(result.toolResultsCleared).toBe(1);
  });

  it("returns correct toolResultsCleared count", () => {
    const first = makeTokenSizedText(420);
    const second = makeTokenSizedText(420);
    const third = makeTokenSizedText(420);
    const messages: CheckpointMessage[] = [
      makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          name: "read_file",
          content: first,
        },
        {
          type: "tool_result",
          tool_use_id: "tool_2",
          name: "read_file",
          content: second,
        },
      ]),
      makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_3",
          name: "read_file",
          content: third,
        },
      ]),
    ];

    const result = microCompactMessages(messages, {
      clearToolResults: true,
      keepRecentToolResults: 1,
      protectRecentTokens: 0,
    });

    expect(result.toolResultsCleared).toBe(2);
    expect(result.messagesModified).toBe(1);
    expect(getLegacyToolResultPart(result.messages[1].message)?.content).toBe(
      third
    );
  });

  it("still shrinks assistant text when tool result clearing is enabled", () => {
    const oldAssistantText = makeTokenSizedText(900);
    const oldToolResultText = makeTokenSizedText(500);
    const recentUserText = makeTokenSizedText(240);
    const messages: CheckpointMessage[] = [
      makeAssistantMessage(oldAssistantText),
      makeUserToolResultMessage([
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          name: "read_file",
          content: oldToolResultText,
        },
      ]),
      makeUserMessage(recentUserText),
    ];

    const result = microCompactMessages(messages, {
      clearToolResults: true,
      keepRecentToolResults: 0,
      maxResponseTokens: 500,
      minSavingsTokens: 1,
      protectRecentTokens: estimateTokens(recentUserText) + 1,
    });

    expect(extractMessageText(result.messages[0].message)).toContain(
      "[response shrunk —"
    );
    expect(getLegacyToolResultPart(result.messages[1].message)?.content).toBe(
      "[tool result cleared]"
    );
    expect(result.messagesModified).toBe(2);
    expect(result.toolResultsCleared).toBe(1);
  });
});
