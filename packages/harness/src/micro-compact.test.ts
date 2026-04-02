import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
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

function makeTokenSizedText(tokens: number): string {
  return "x".repeat(tokens * 4);
}

function estimateCheckpointTokens(messages: CheckpointMessage[]): number {
  return messages.reduce((total, checkpoint) => {
    return total + estimateTokens(extractMessageText(checkpoint.message));
  }, 0);
}

describe("microCompactMessages", () => {
  beforeEach(() => {
    checkpointId = 0;
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
});
