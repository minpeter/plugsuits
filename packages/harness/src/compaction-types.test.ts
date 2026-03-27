import { describe, expect, it } from "vitest";
import type {
  Message,
  CheckpointMessage,
  SessionMetadata,
  CompactionConfig,
  PruningConfig,
  ContinuationVariant,
  CompactionResult,
  PreparedCompactionV2,
  ActualTokenUsage,
  ActualTokenUsageInput,
  ContextUsage,
  TodoItem,
  StructuredState,
  SessionHeaderLine,
  MessageLine,
  CheckpointLine,
  SessionFileLine,
  CompactionSummary,
  CompactionSegment,
  PreparedCompactionSegment,
  PreparedCompaction,
} from "./compaction-types";
import type { ModelMessage } from "ai";

// ============================================
// Test Helpers
// ============================================

/** Minimal valid ModelMessage for testing */
const createMockModelMessage = (): ModelMessage => ({
  role: "user",
  content: [{ type: "text", text: "test" }],
});

// ============================================
// Message Interface Tests
// ============================================

describe("Message", () => {
  it("should have all required fields", () => {
    const message: Message = {
      createdAt: new Date(),
      id: "msg-123",
      modelMessage: createMockModelMessage(),
    };

    expect(message.createdAt).toBeInstanceOf(Date);
    expect(message.id).toBe("msg-123");
    expect(message.modelMessage).toBeDefined();
    expect(message.modelMessage.role).toBe("user");
  });

  it("should allow optional originalContent field", () => {
    const message: Message = {
      createdAt: new Date(),
      id: "msg-123",
      modelMessage: createMockModelMessage(),
      originalContent: "original text",
    };

    expect(message.originalContent).toBe("original text");
  });

  it("should allow undefined for optional fields", () => {
    const message: Message = {
      createdAt: new Date(),
      id: "msg-123",
      modelMessage: createMockModelMessage(),
    };

    expect(message.originalContent).toBeUndefined();
  });

  it("should use Date type for createdAt field", () => {
    const date = new Date("2024-01-01T00:00:00Z");
    const message: Message = {
      createdAt: date,
      id: "msg-123",
      modelMessage: createMockModelMessage(),
    };

    expect(message.createdAt).toEqual(date);
  });
});

// ============================================
// CheckpointMessage Interface Tests
// ============================================

describe("CheckpointMessage", () => {
  it("should have all required fields", () => {
    const checkpoint: CheckpointMessage = {
      createdAt: 1704067200000, // timestamp in milliseconds
      id: "checkpoint-123",
      isSummary: false,
      message: createMockModelMessage(),
    };

    expect(checkpoint.createdAt).toBe(1704067200000);
    expect(checkpoint.id).toBe("checkpoint-123");
    expect(checkpoint.isSummary).toBe(false);
    expect(checkpoint.message).toBeDefined();
  });

  it("should allow optional originalContent field", () => {
    const checkpoint: CheckpointMessage = {
      createdAt: 1704067200000,
      id: "checkpoint-123",
      isSummary: true,
      message: createMockModelMessage(),
      originalContent: "original summary",
    };

    expect(checkpoint.originalContent).toBe("original summary");
  });

  it("should allow undefined for optional fields", () => {
    const checkpoint: CheckpointMessage = {
      createdAt: 1704067200000,
      id: "checkpoint-123",
      isSummary: false,
      message: createMockModelMessage(),
    };

    expect(checkpoint.originalContent).toBeUndefined();
  });

  it("should use number type for createdAt field (different from Message)", () => {
    const message: Message = {
      createdAt: new Date(),
      id: "msg-123",
      modelMessage: createMockModelMessage(),
    };
    const checkpoint: CheckpointMessage = {
      createdAt: Date.now(),
      id: "cp-123",
      isSummary: false,
      message: createMockModelMessage(),
    };

    expect(message.createdAt).toBeInstanceOf(Date);
    expect(typeof checkpoint.createdAt).toBe("number");
  });
});

// ============================================
// SessionMetadata Interface Tests
// ============================================

describe("SessionMetadata", () => {
  it("should have all required fields", () => {
    const metadata: SessionMetadata = {
      completionTokens: 100,
      createdAt: 1704067200000,
      promptTokens: 50,
      sessionId: "session-123",
      summaryMessageId: null,
      updatedAt: 1704067200001,
    };

    expect(metadata.completionTokens).toBe(100);
    expect(metadata.createdAt).toBe(1704067200000);
    expect(metadata.promptTokens).toBe(50);
    expect(metadata.sessionId).toBe("session-123");
    expect(metadata.summaryMessageId).toBe(null);
    expect(metadata.updatedAt).toBe(1704067200001);
  });

  it("should allow non-null summaryMessageId", () => {
    const metadata: SessionMetadata = {
      completionTokens: 100,
      createdAt: 1704067200000,
      promptTokens: 50,
      sessionId: "session-123",
      summaryMessageId: "summary-msg-456",
      updatedAt: 1704067200001,
    };

    expect(typeof metadata.summaryMessageId).toBe("string");
    expect(metadata.summaryMessageId).toBe("summary-msg-456");
  });

  it("should use number type for timestamp fields", () => {
    const metadata: SessionMetadata = {
      completionTokens: 50,
      createdAt: 1704067200000,
      promptTokens: 25,
      sessionId: "session-123",
      summaryMessageId: null,
      updatedAt: 1704067200000,
    };

    expect(typeof metadata.createdAt).toBe("number");
    expect(typeof metadata.updatedAt).toBe("number");
  });
});

// ============================================
// CompactionConfig Interface Tests
// ============================================

describe("CompactionConfig", () => {
  const defaultConfig: CompactionConfig = {};

  it("should allow empty config with all defaults", () => {
    const config: CompactionConfig = {};

    expect(config.enabled).toBeUndefined();
    expect(config.keepRecentTokens).toBeUndefined();
    expect(config.maxTokens).toBeUndefined();
    expect(config.reserveTokens).toBeUndefined();
    expect(config.thresholdRatio).toBeUndefined();
  });

  it("should verify default values when fields are undefined", () => {
    const config: CompactionConfig = {};

    // Default values from JSDoc comments
    expect(config.enabled ?? false).toBe(false);
    expect(config.keepRecentTokens ?? 2000).toBe(2000);
    expect(config.maxTokens ?? 8000).toBe(8000);
    expect(config.reserveTokens ?? 2000).toBe(2000);
    expect(config.thresholdRatio ?? 0.5).toBe(0.5);
    expect(config.speculativeStartRatio ?? 0.5).toBe(0.5);
  });

  it("should accept all optional fields", () => {
    const config: CompactionConfig = {
      contextLimit: 128000,
      enabled: true,
      keepRecentTokens: 3000,
      maxTokens: 10000,
      reserveTokens: 3000,
      speculativeStartRatio: 0.6,
      summarizeFn: async (msgs) => "summary",
      thresholdRatio: 0.6,
    };

    expect(config.contextLimit).toBe(128000);
    expect(config.enabled).toBe(true);
    expect(config.keepRecentTokens).toBe(3000);
    expect(config.maxTokens).toBe(10000);
    expect(config.reserveTokens).toBe(3000);
    expect(config.speculativeStartRatio).toBe(0.6);
    expect(config.summarizeFn).toBeDefined();
    expect(config.thresholdRatio).toBe(0.6);
  });

  it("should allow custom summarizeFn", async () => {
    const summarizeFn = async (messages: ModelMessage[], previousSummary?: string) => {
      return `Summarized ${messages.length} messages`;
    };

    const config: CompactionConfig = { summarizeFn };

    const result = await config.summarizeFn!([createMockModelMessage()], "previous");
    expect(result).toBe("Summarized 1 messages");
  });

  it("should allow contextLimit to be 0 for unlimited context", () => {
    const config: CompactionConfig = {
      contextLimit: 0,
    };

    expect(config.contextLimit).toBe(0);
  });

  it("should allow contextLimit to be undefined for unlimited context", () => {
    const config: CompactionConfig = {};

    expect(config.contextLimit).toBeUndefined();
  });
});

// ============================================
// PruningConfig Interface Tests
// ============================================

describe("PruningConfig", () => {
  it("should have all default values when empty", () => {
    const config: PruningConfig = {};

    expect(config.enabled ?? false).toBe(false);
    expect(config.minSavingsTokens ?? 200).toBe(200);
    expect(config.protectRecentTokens ?? 2000).toBe(2000);
    expect(config.replacementText ?? "[output pruned — too large]").toBe(
      "[output pruned — too large]"
    );
  });

  it("should accept all optional fields", () => {
    const config: PruningConfig = {
      enabled: true,
      minSavingsTokens: 500,
      protectedToolNames: ["tool1", "tool2"],
      protectRecentTokens: 3000,
      replacementText: "[pruned]",
    };

    expect(config.enabled).toBe(true);
    expect(config.minSavingsTokens).toBe(500);
    expect(config.protectedToolNames).toEqual(["tool1", "tool2"]);
    expect(config.protectRecentTokens).toBe(3000);
    expect(config.replacementText).toBe("[pruned]");
  });

  it("should allow protectedToolNames to be empty array", () => {
    const config: PruningConfig = {
      protectedToolNames: [],
    };

    expect(config.protectedToolNames).toEqual([]);
  });

  it("should allow undefined protectedToolNames", () => {
    const config: PruningConfig = {};

    expect(config.protectedToolNames).toBeUndefined();
  });
});

// ============================================
// ContinuationVariant Union Type Tests
// ============================================

describe("ContinuationVariant", () => {
  it("should accept 'manual' variant", () => {
    const variant: ContinuationVariant = "manual";

    expect(variant).toBe("manual");
  });

  it("should accept 'auto-with-replay' variant", () => {
    const variant: ContinuationVariant = "auto-with-replay";

    expect(variant).toBe("auto-with-replay");
  });

  it("should accept 'tool-loop' variant", () => {
    const variant: ContinuationVariant = "tool-loop";

    expect(variant).toBe("tool-loop");
  });

  it("should reject invalid variants", () => {
    // @ts-expect-error - invalid variant should cause type error
    const invalid: ContinuationVariant = "invalid";

    expect(invalid).toBe("invalid");
  });

  it("should work in switch statements", () => {
    const testVariant = (variant: ContinuationVariant): string => {
      switch (variant) {
        case "manual":
          return "manual continuation";
        case "auto-with-replay":
          return "auto with replay";
        case "tool-loop":
          return "tool loop";
        default:
          return "unknown";
      }
    };

    expect(testVariant("manual")).toBe("manual continuation");
    expect(testVariant("auto-with-replay")).toBe("auto with replay");
    expect(testVariant("tool-loop")).toBe("tool loop");
  });
});

// ============================================
// CompactionResult Interface Tests
// ============================================

describe("CompactionResult", () => {
  it("should require success, tokensBefore, and tokensAfter fields", () => {
    const result: CompactionResult = {
      success: true,
      tokensBefore: 10000,
      tokensAfter: 5000,
    };

    expect(result.success).toBe(true);
    expect(result.tokensBefore).toBe(10000);
    expect(result.tokensAfter).toBe(5000);
  });

  it("should allow optional continuationVariant", () => {
    const result: CompactionResult = {
      success: true,
      tokensBefore: 10000,
      tokensAfter: 5000,
      continuationVariant: "manual",
    };

    expect(result.continuationVariant).toBe("manual");
  });

  it("should allow optional reason (failure case)", () => {
    const result: CompactionResult = {
      success: false,
      tokensBefore: 10000,
      tokensAfter: 10000,
      reason: "Tokens below threshold",
    };

    expect(result.success).toBe(false);
    expect(result.reason).toBe("Tokens below threshold");
  });

  it("should allow optional summaryMessageId", () => {
    const result: CompactionResult = {
      success: true,
      tokensBefore: 10000,
      tokensAfter: 5000,
      summaryMessageId: "summary-msg-123",
    };

    expect(result.summaryMessageId).toBe("summary-msg-123");
  });

  it("should calculate tokenDelta correctly", () => {
    const result: CompactionResult = {
      success: true,
      tokensBefore: 10000,
      tokensAfter: 5000,
      tokenDelta: -5000,
    };

    expect(result.tokensBefore - result.tokensAfter).toBe(5000);
  });
});

// ============================================
// PreparedCompactionV2 Interface Tests
// ============================================

describe("PreparedCompactionV2", () => {
  it("should have all required fields", () => {
    const compaction: PreparedCompactionV2 = {
      baseMessageIds: ["msg-1", "msg-2", "msg-3"],
      revision: 1,
      splitIndex: 2,
      summaryText: "Compacted summary",
      tokenDelta: -5000,
    };

    expect(compaction.baseMessageIds).toHaveLength(3);
    expect(compaction.revision).toBe(1);
    expect(compaction.splitIndex).toBe(2);
    expect(compaction.summaryText).toBe("Compacted summary");
    expect(compaction.tokenDelta).toBe(-5000);
  });

  it("should allow optional replayMessage", () => {
    const compaction: PreparedCompactionV2 = {
      baseMessageIds: ["msg-1", "msg-2"],
      replayMessage: {
        createdAt: 1704067200000,
        id: "replay-msg",
        isSummary: true,
        message: createMockModelMessage(),
      },
      revision: 2,
      splitIndex: 1,
      summaryText: "New summary",
      tokenDelta: -3000,
    };

    expect(compaction.replayMessage).toBeDefined();
    expect(compaction.replayMessage?.id).toBe("replay-msg");
  });

  it("should allow undefined replayMessage", () => {
    const compaction: PreparedCompactionV2 = {
      baseMessageIds: ["msg-1"],
      revision: 1,
      splitIndex: 0,
      summaryText: "Summary",
      tokenDelta: -1000,
    };

    expect(compaction.replayMessage).toBeUndefined();
  });
});

// ============================================
// ActualTokenUsage Interface Tests
// ============================================

describe("ActualTokenUsage", () => {
  it("should have all required fields", () => {
    const usage: ActualTokenUsage = {
      completionTokens: 100,
      promptTokens: 50,
      totalTokens: 150,
      updatedAt: new Date(),
    };

    expect(usage.completionTokens).toBe(100);
    expect(usage.promptTokens).toBe(50);
    expect(usage.totalTokens).toBe(150);
    expect(usage.updatedAt).toBeInstanceOf(Date);
  });

  it("should calculate totalTokens from sum of components", () => {
    const usage: ActualTokenUsage = {
      completionTokens: 200,
      promptTokens: 100,
      totalTokens: 300,
      updatedAt: new Date(),
    };

    expect(usage.totalTokens).toBe(usage.completionTokens + usage.promptTokens);
  });

  it("should use Date type for updatedAt field", () => {
    const date = new Date("2024-01-01T00:00:00Z");
    const usage: ActualTokenUsage = {
      completionTokens: 50,
      promptTokens: 25,
      totalTokens: 75,
      updatedAt: date,
    };

    expect(usage.updatedAt).toEqual(date);
  });
});

// ============================================
// ActualTokenUsageInput Interface Tests
// ============================================

describe("ActualTokenUsageInput", () => {
  it("should allow all optional fields to be undefined", () => {
    const input: ActualTokenUsageInput = {};

    expect(input.completionTokens).toBeUndefined();
    expect(input.inputTokens).toBeUndefined();
    expect(input.outputTokens).toBeUndefined();
    expect(input.promptTokens).toBeUndefined();
    expect(input.totalTokens).toBeUndefined();
    expect(input.updatedAt).toBeUndefined();
  });

  it("should accept all optional fields", () => {
    const input: ActualTokenUsageInput = {
      completionTokens: 100,
      inputTokens: 50,
      outputTokens: 100,
      promptTokens: 50,
      totalTokens: 150,
      updatedAt: new Date(),
    };

    expect(input.completionTokens).toBe(100);
    expect(input.inputTokens).toBe(50);
    expect(input.outputTokens).toBe(100);
    expect(input.promptTokens).toBe(50);
    expect(input.totalTokens).toBe(150);
    expect(input.updatedAt).toBeInstanceOf(Date);
  });

  it("should be compatible with ActualTokenUsage (input can become output)", () => {
    const input: ActualTokenUsageInput = {
      completionTokens: 100,
      inputTokens: 50,
      outputTokens: 100,
      promptTokens: 50,
      totalTokens: 150,
      updatedAt: new Date(),
    };

    // Input can be used where ActualTokenUsage is expected when all fields are provided
    const output: ActualTokenUsage = {
      completionTokens: input.completionTokens!,
      promptTokens: input.promptTokens!,
      totalTokens: input.totalTokens!,
      updatedAt: input.updatedAt!,
    };

    expect(output.completionTokens).toBe(100);
    expect(output.promptTokens).toBe(50);
  });

  it("should handle partial updates", () => {
    const input: ActualTokenUsageInput = {
      promptTokens: 100,
    };

    expect(input.promptTokens).toBe(100);
    expect(input.completionTokens).toBeUndefined();
  });
});

// ============================================
// ContextUsage Interface Tests
// ============================================

describe("ContextUsage", () => {
  it("should have all required fields", () => {
    const usage: ContextUsage = {
      limit: 128000,
      percentage: 50,
      remaining: 64000,
      source: "actual",
      used: 64000,
    };

    expect(usage.limit).toBe(128000);
    expect(usage.percentage).toBe(50);
    expect(usage.remaining).toBe(64000);
    expect(usage.source).toBe("actual");
    expect(usage.used).toBe(64000);
  });

  it("should accept 'estimated' source", () => {
    const usage: ContextUsage = {
      limit: 128000,
      percentage: 75,
      remaining: 32000,
      source: "estimated",
      used: 96000,
    };

    expect(usage.source).toBe("estimated");
  });

  it("should calculate percentage correctly", () => {
    const usage: ContextUsage = {
      limit: 1000,
      percentage: 0,
      remaining: 1000,
      source: "actual",
      used: 0,
    };

    usage.used = 250;
    usage.percentage = (usage.used / usage.limit) * 100;

    expect(usage.percentage).toBe(25);
  });

  it("should calculate remaining correctly", () => {
    const usage: ContextUsage = {
      limit: 1000,
      percentage: 0,
      remaining: 0,
      source: "actual",
      used: 1000,
    };

    usage.remaining = usage.limit - usage.used;

    expect(usage.remaining).toBe(0);
  });

  it("should reject invalid source values", () => {
    // @ts-expect-error - invalid source should cause type error
    const invalid: ContextUsage = {
      limit: 1000,
      percentage: 50,
      remaining: 500,
      source: "invalid",
      used: 500,
    };

    expect(invalid.source).toBe("invalid");
  });
});

// ============================================
// TodoItem Interface Tests
// ============================================

describe("TodoItem", () => {
  it("should have all required fields", () => {
    const todo: TodoItem = {
      content: "Buy groceries",
      status: "pending",
    };

    expect(todo.content).toBe("Buy groceries");
    expect(todo.status).toBe("pending");
  });

  it("should accept 'in_progress' status", () => {
    const todo: TodoItem = {
      content: "Write code",
      status: "in_progress",
    };

    expect(todo.status).toBe("in_progress");
  });

  it("should accept 'completed' status", () => {
    const todo: TodoItem = {
      content: "Review PR",
      status: "completed",
    };

    expect(todo.status).toBe("completed");
  });

  it("should accept 'cancelled' status", () => {
    const todo: TodoItem = {
      content: "Cancel task",
      status: "cancelled",
    };

    expect(todo.status).toBe("cancelled");
  });

  it("should reject invalid status values", () => {
    // @ts-expect-error - invalid status should cause type error
    const invalid: TodoItem = {
      content: "Task",
      status: "invalid",
    };

    expect(invalid.status).toBe("invalid");
  });
});

// ============================================
// StructuredState Interface Tests
// ============================================

describe("StructuredState", () => {
  it("should allow empty state", () => {
    const state: StructuredState = {};

    expect(state.metadata).toBeUndefined();
    expect(state.todos).toBeUndefined();
  });

  it("should accept optional metadata", () => {
    const state: StructuredState = {
      metadata: {
        key1: "value1",
        key2: 123,
        key3: true,
      },
    };

    expect(state.metadata).toBeDefined();
    expect(state.metadata?.key1).toBe("value1");
    expect(state.metadata?.key2).toBe(123);
    expect(state.metadata?.key3).toBe(true);
  });

  it("should accept optional todos array", () => {
    const state: StructuredState = {
      todos: [
        { content: "Task 1", status: "pending" },
        { content: "Task 2", status: "in_progress" },
        { content: "Task 3", status: "completed" },
      ],
    };

    expect(state.todos).toHaveLength(3);
    expect(state.todos?.[0].status).toBe("pending");
    expect(state.todos?.[1].status).toBe("in_progress");
    expect(state.todos?.[2].status).toBe("completed");
  });

  it("should allow empty todos array", () => {
    const state: StructuredState = {
      todos: [],
    };

    expect(state.todos).toEqual([]);
  });

  it("should accept both metadata and todos together", () => {
    const state: StructuredState = {
      metadata: { version: "1.0" },
      todos: [{ content: "Test", status: "pending" }],
    };

    expect(state.metadata).toBeDefined();
    expect(state.todos).toBeDefined();
  });
});

// ============================================
// SessionHeaderLine Interface Tests
// ============================================

describe("SessionHeaderLine", () => {
  it("should have all required fields", () => {
    const header: SessionHeaderLine = {
      createdAt: 1704067200000,
      sessionId: "session-123",
      type: "header",
      version: 1,
    };

    expect(header.createdAt).toBe(1704067200000);
    expect(header.sessionId).toBe("session-123");
    expect(header.type).toBe("header");
    expect(header.version).toBe(1);
  });

  it("should have literal type 'header' for type field", () => {
    const header: SessionHeaderLine = {
      createdAt: 1704067200000,
      sessionId: "session-123",
      type: "header",
      version: 1,
    };

    expect(header.type).toBe("header");
    // @ts-expect-error - different literal should cause type error
    header.type = "message";
  });

  it("should have literal type 1 for version field", () => {
    const header: SessionHeaderLine = {
      createdAt: 1704067200000,
      sessionId: "session-123",
      type: "header",
      version: 1,
    };

    expect(header.version).toBe(1);
    // @ts-expect-error - different version should cause type error
    header.version = 2;
  });
});

// ============================================
// MessageLine Interface Tests
// ============================================

describe("MessageLine", () => {
  it("should have all required fields", () => {
    const messageLine: MessageLine = {
      createdAt: 1704067200000,
      id: "msg-123",
      isSummary: false,
      message: createMockModelMessage(),
      type: "message",
    };

    expect(messageLine.createdAt).toBe(1704067200000);
    expect(messageLine.id).toBe("msg-123");
    expect(messageLine.isSummary).toBe(false);
    expect(messageLine.message).toBeDefined();
    expect(messageLine.type).toBe("message");
  });

  it("should allow optional originalContent", () => {
    const messageLine: MessageLine = {
      createdAt: 1704067200000,
      id: "msg-123",
      isSummary: true,
      message: createMockModelMessage(),
      originalContent: "original content",
      type: "message",
    };

    expect(messageLine.originalContent).toBe("original content");
  });

  it("should allow undefined originalContent", () => {
    const messageLine: MessageLine = {
      createdAt: 1704067200000,
      id: "msg-123",
      isSummary: false,
      message: createMockModelMessage(),
      type: "message",
    };

    expect(messageLine.originalContent).toBeUndefined();
  });

  it("should have literal type 'message' for type field", () => {
    const messageLine: MessageLine = {
      createdAt: 1704067200000,
      id: "msg-123",
      isSummary: false,
      message: createMockModelMessage(),
      type: "message",
    };

    expect(messageLine.type).toBe("message");
  });
});

// ============================================
// CheckpointLine Interface Tests
// ============================================

describe("CheckpointLine", () => {
  it("should have all required fields", () => {
    const checkpoint: CheckpointLine = {
      summaryMessageId: "summary-msg-456",
      type: "checkpoint",
      updatedAt: 1704067200001,
    };

    expect(checkpoint.summaryMessageId).toBe("summary-msg-456");
    expect(checkpoint.type).toBe("checkpoint");
    expect(checkpoint.updatedAt).toBe(1704067200001);
  });

  it("should have literal type 'checkpoint' for type field", () => {
    const checkpoint: CheckpointLine = {
      summaryMessageId: "summary-msg-456",
      type: "checkpoint",
      updatedAt: 1704067200001,
    };

    expect(checkpoint.type).toBe("checkpoint");
  });
});

// ============================================
// SessionFileLine Discriminated Union Type Tests
// ============================================

describe("SessionFileLine (Discriminated Union)", () => {
  it("should accept SessionHeaderLine as valid type", () => {
    const line: SessionFileLine = {
      createdAt: 1704067200000,
      sessionId: "session-123",
      type: "header",
      version: 1,
    };

    expect(line.type).toBe("header");
  });

  it("should accept MessageLine as valid type", () => {
    const line: SessionFileLine = {
      createdAt: 1704067200000,
      id: "msg-123",
      isSummary: false,
      message: createMockModelMessage(),
      type: "message",
    };

    expect(line.type).toBe("message");
  });

  it("should accept CheckpointLine as valid type", () => {
    const line: SessionFileLine = {
      summaryMessageId: "summary-msg-456",
      type: "checkpoint",
      updatedAt: 1704067200001,
    };

    expect(line.type).toBe("checkpoint");
  });

  it("should narrow type using discriminated union", () => {
    const headerLine: SessionFileLine = {
      createdAt: 1704067200000,
      sessionId: "session-123",
      type: "header",
      version: 1,
    };

    const messageLine: SessionFileLine = {
      createdAt: 1704067200000,
      id: "msg-123",
      isSummary: false,
      message: createMockModelMessage(),
      type: "message",
    };

    const checkpointLine: SessionFileLine = {
      summaryMessageId: "summary-msg-456",
      type: "checkpoint",
      updatedAt: 1704067200001,
    };

    // Type narrowing via switch
    const processLine = (line: SessionFileLine): string => {
      switch (line.type) {
        case "header":
          return `Header: ${line.sessionId}`;
        case "message":
          return `Message: ${line.id}`;
        case "checkpoint":
          return `Checkpoint: ${line.summaryMessageId}`;
        default:
          return "Unknown";
      }
    };

    expect(processLine(headerLine)).toBe("Header: session-123");
    expect(processLine(messageLine)).toBe("Message: msg-123");
    expect(processLine(checkpointLine)).toBe("Checkpoint: summary-msg-456");
  });

  it("should have correct field access per discriminated type", () => {
    const lines: SessionFileLine[] = [
      {
        createdAt: 1704067200000,
        sessionId: "session-123",
        type: "header",
        version: 1,
      },
      {
        createdAt: 1704067200000,
        id: "msg-123",
        isSummary: false,
        message: createMockModelMessage(),
        type: "message",
      },
      {
        summaryMessageId: "summary-msg-456",
        type: "checkpoint",
        updatedAt: 1704067200001,
      },
    ];

    // Header-specific fields
    expect((lines[0] as SessionHeaderLine).sessionId).toBe("session-123");
    expect((lines[0] as SessionHeaderLine).version).toBe(1);

    // Message-specific fields
    expect((lines[1] as MessageLine).id).toBe("msg-123");
    expect((lines[1] as MessageLine).isSummary).toBe(false);

    // Checkpoint-specific fields
    expect((lines[2] as CheckpointLine).summaryMessageId).toBe("summary-msg-456");
  });
});

// ============================================
// CompactionSummary Interface Tests
// ============================================

describe("CompactionSummary", () => {
  it("should have all required fields", () => {
    const summary: CompactionSummary = {
      createdAt: new Date(),
      firstKeptMessageId: "msg-5",
      id: "summary-123",
      summary: "Compressed conversation summary",
      summaryTokens: 500,
      tokensBefore: 10000,
    };

    expect(summary.createdAt).toBeInstanceOf(Date);
    expect(summary.firstKeptMessageId).toBe("msg-5");
    expect(summary.id).toBe("summary-123");
    expect(summary.summary).toBe("Compressed conversation summary");
    expect(summary.summaryTokens).toBe(500);
    expect(summary.tokensBefore).toBe(10000);
  });

  it("should use Date type for createdAt field", () => {
    const summary: CompactionSummary = {
      createdAt: new Date("2024-01-01T00:00:00Z"),
      firstKeptMessageId: "msg-1",
      id: "summary-123",
      summary: "test",
      summaryTokens: 100,
      tokensBefore: 1000,
    };

    expect(summary.createdAt).toEqual(new Date("2024-01-01T00:00:00Z"));
  });

  it("should calculate savings from tokensBefore - summaryTokens", () => {
    const summary: CompactionSummary = {
      createdAt: new Date(),
      firstKeptMessageId: "msg-1",
      id: "summary-123",
      summary: "test",
      summaryTokens: 200,
      tokensBefore: 2000,
    };

    const savings = summary.tokensBefore - summary.summaryTokens;
    expect(savings).toBe(1800);
  });
});

// ============================================
// CompactionSegment Interface Tests
// ============================================

describe("CompactionSegment", () => {
  it("should have all required fields", () => {
    const segment: CompactionSegment = {
      createdAt: new Date(),
      endMessageId: "msg-10",
      estimatedTokens: 5000,
      id: "segment-123",
      messageCount: 10,
      messageIds: ["msg-1", "msg-2", "msg-3"],
      messages: [],
      startMessageId: "msg-1",
      summary: null,
    };

    expect(segment.createdAt).toBeInstanceOf(Date);
    expect(segment.endMessageId).toBe("msg-10");
    expect(segment.estimatedTokens).toBe(5000);
    expect(segment.id).toBe("segment-123");
    expect(segment.messageCount).toBe(10);
    expect(segment.messageIds).toHaveLength(3);
    expect(segment.messages).toEqual([]);
    expect(segment.startMessageId).toBe("msg-1");
    expect(segment.summary).toBe(null);
  });

  it("should allow summary to be CompactionSummary", () => {
    const summary: CompactionSummary = {
      createdAt: new Date(),
      firstKeptMessageId: "msg-5",
      id: "summary-123",
      summary: "test",
      summaryTokens: 100,
      tokensBefore: 1000,
    };

    const segment: CompactionSegment = {
      createdAt: new Date(),
      endMessageId: "msg-10",
      estimatedTokens: 5000,
      id: "segment-123",
      messageCount: 10,
      messageIds: ["msg-1", "msg-2"],
      messages: [],
      startMessageId: "msg-1",
      summary: summary,
    };

    expect(segment.summary).toBeDefined();
    expect(segment.summary?.id).toBe("summary-123");
  });

  it("should allow summary to be null", () => {
    const segment: CompactionSegment = {
      createdAt: new Date(),
      endMessageId: "msg-10",
      estimatedTokens: 5000,
      id: "segment-123",
      messageCount: 10,
      messageIds: ["msg-1", "msg-2"],
      messages: [],
      startMessageId: "msg-1",
      summary: null,
    };

    expect(segment.summary).toBe(null);
  });

  it("should contain Message array in messages field", () => {
    const messages: Message[] = [
      {
        createdAt: new Date(),
        id: "msg-1",
        modelMessage: createMockModelMessage(),
      },
      {
        createdAt: new Date(),
        id: "msg-2",
        modelMessage: createMockModelMessage(),
      },
    ];

    const segment: CompactionSegment = {
      createdAt: new Date(),
      endMessageId: "msg-2",
      estimatedTokens: 1000,
      id: "segment-123",
      messageCount: 2,
      messageIds: ["msg-1", "msg-2"],
      messages: messages,
      startMessageId: "msg-1",
      summary: null,
    };

    expect(segment.messages).toHaveLength(2);
    expect(segment.messages[0].id).toBe("msg-1");
    expect(segment.messages[1].id).toBe("msg-2");
  });
});

// ============================================
// PreparedCompactionSegment Interface Tests
// ============================================

describe("PreparedCompactionSegment", () => {
  it("should have same structure as CompactionSegment", () => {
    const segment: PreparedCompactionSegment = {
      createdAt: new Date(),
      endMessageId: "msg-10",
      estimatedTokens: 5000,
      id: "segment-123",
      messageCount: 10,
      messageIds: ["msg-1", "msg-2", "msg-3"],
      messages: [],
      startMessageId: "msg-1",
      summary: null,
    };

    // Should have all the same fields as CompactionSegment
    expect(segment.createdAt).toBeInstanceOf(Date);
    expect(segment.endMessageId).toBe("msg-10");
    expect(segment.estimatedTokens).toBe(5000);
    expect(segment.id).toBe("segment-123");
    expect(segment.messageCount).toBe(10);
    expect(segment.messageIds).toHaveLength(3);
    expect(segment.messages).toEqual([]);
    expect(segment.startMessageId).toBe("msg-1");
    expect(segment.summary).toBe(null);
  });

  it("should be structurally compatible with CompactionSegment", () => {
    const preparedSegment: PreparedCompactionSegment = {
      createdAt: new Date(),
      endMessageId: "msg-10",
      estimatedTokens: 5000,
      id: "segment-123",
      messageCount: 10,
      messageIds: ["msg-1", "msg-2"],
      messages: [],
      startMessageId: "msg-1",
      summary: null,
    };

    // Type compatibility - should be assignable to CompactionSegment
    const compactSegment: CompactionSegment = preparedSegment;

    expect(compactSegment.id).toBe("segment-123");
  });

  it("should allow summary with CompactionSummary", () => {
    const summary: CompactionSummary = {
      createdAt: new Date(),
      firstKeptMessageId: "msg-5",
      id: "summary-123",
      summary: "test",
      summaryTokens: 100,
      tokensBefore: 1000,
    };

    const segment: PreparedCompactionSegment = {
      createdAt: new Date(),
      endMessageId: "msg-10",
      estimatedTokens: 5000,
      id: "segment-123",
      messageCount: 10,
      messageIds: ["msg-1", "msg-2"],
      messages: [],
      startMessageId: "msg-1",
      summary: summary,
    };

    expect(segment.summary).toBeDefined();
    expect(segment.summary).not.toBeNull();
  });
});

// ============================================
// PreparedCompaction Interface Tests
// ============================================

describe("PreparedCompaction", () => {
  it("should have all required fields", () => {
    const compaction: PreparedCompaction = {
      actualUsage: null,
      baseMessageIds: ["msg-1", "msg-2"],
      baseRevision: 1,
      baseSegmentIds: ["seg-1"],
      compactionMaxTokensAtCreation: 8000,
      contextLimitAtCreation: 128000,
      didChange: true,
      keepRecentTokensAtCreation: 2000,
      pendingCompaction: true,
      phase: "intermediate-step",
      rejected: false,
      segments: [],
      tokenDelta: -5000,
    };

    expect(compaction.actualUsage).toBe(null);
    expect(compaction.baseMessageIds).toHaveLength(2);
    expect(compaction.baseRevision).toBe(1);
    expect(compaction.baseSegmentIds).toHaveLength(1);
    expect(compaction.compactionMaxTokensAtCreation).toBe(8000);
    expect(compaction.contextLimitAtCreation).toBe(128000);
    expect(compaction.didChange).toBe(true);
    expect(compaction.keepRecentTokensAtCreation).toBe(2000);
    expect(compaction.pendingCompaction).toBe(true);
    expect(compaction.phase).toBe("intermediate-step");
    expect(compaction.rejected).toBe(false);
    expect(compaction.segments).toEqual([]);
    expect(compaction.tokenDelta).toBe(-5000);
  });

  it("should accept 'new-turn' phase", () => {
    const compaction: PreparedCompaction = {
      actualUsage: null,
      baseMessageIds: ["msg-1"],
      baseRevision: 1,
      baseSegmentIds: ["seg-1"],
      compactionMaxTokensAtCreation: 8000,
      contextLimitAtCreation: 128000,
      didChange: false,
      keepRecentTokensAtCreation: 2000,
      pendingCompaction: false,
      phase: "new-turn",
      rejected: false,
      segments: [],
      tokenDelta: 0,
    };

    expect(compaction.phase).toBe("new-turn");
  });

  it("should allow actualUsage to be ActualTokenUsage", () => {
    const usage: ActualTokenUsage = {
      completionTokens: 100,
      promptTokens: 50,
      totalTokens: 150,
      updatedAt: new Date(),
    };

    const compaction: PreparedCompaction = {
      actualUsage: usage,
      baseMessageIds: ["msg-1"],
      baseRevision: 1,
      baseSegmentIds: ["seg-1"],
      compactionMaxTokensAtCreation: 8000,
      contextLimitAtCreation: 128000,
      didChange: true,
      keepRecentTokensAtCreation: 2000,
      pendingCompaction: true,
      phase: "intermediate-step",
      rejected: false,
      segments: [],
      tokenDelta: -100,
    };

    expect(compaction.actualUsage).toBeDefined();
    expect(compaction.actualUsage?.totalTokens).toBe(150);
  });

  it("should allow empty segments array", () => {
    const compaction: PreparedCompaction = {
      actualUsage: null,
      baseMessageIds: [],
      baseRevision: 0,
      baseSegmentIds: [],
      compactionMaxTokensAtCreation: 0,
      contextLimitAtCreation: 0,
      didChange: false,
      keepRecentTokensAtCreation: 0,
      pendingCompaction: false,
      phase: "new-turn",
      rejected: false,
      segments: [],
      tokenDelta: 0,
    };

    expect(compaction.segments).toEqual([]);
  });

  it("should accept PreparedCompactionSegment array", () => {
    const segments: PreparedCompactionSegment[] = [
      {
        createdAt: new Date(),
        endMessageId: "msg-5",
        estimatedTokens: 3000,
        id: "seg-1",
        messageCount: 5,
        messageIds: ["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"],
        messages: [],
        startMessageId: "msg-1",
        summary: null,
      },
    ];

    const compaction: PreparedCompaction = {
      actualUsage: null,
      baseMessageIds: ["msg-1"],
      baseRevision: 1,
      baseSegmentIds: ["seg-1"],
      compactionMaxTokensAtCreation: 8000,
      contextLimitAtCreation: 128000,
      didChange: true,
      keepRecentTokensAtCreation: 2000,
      pendingCompaction: true,
      phase: "intermediate-step",
      rejected: false,
      segments: segments,
      tokenDelta: -3000,
    };

    expect(compaction.segments).toHaveLength(1);
    expect(compaction.segments[0].id).toBe("seg-1");
  });

  it("should reject invalid phase values", () => {
    // @ts-expect-error - invalid phase should cause type error
    const invalid: PreparedCompaction = {
      actualUsage: null,
      baseMessageIds: [],
      baseRevision: 0,
      baseSegmentIds: [],
      compactionMaxTokensAtCreation: 0,
      contextLimitAtCreation: 0,
      didChange: false,
      keepRecentTokensAtCreation: 0,
      pendingCompaction: false,
      phase: "invalid-phase",
      rejected: false,
      segments: [],
      tokenDelta: 0,
    };

    expect(invalid.phase).toBe("invalid-phase");
  });
});

// ============================================
// Type Compatibility Tests
// ============================================

describe("Type Compatibility", () => {
  it("ActualTokenUsageInput should be convertible to ActualTokenUsage", () => {
    const input: ActualTokenUsageInput = {
      completionTokens: 100,
      promptTokens: 50,
      totalTokens: 150,
      updatedAt: new Date(),
    };

    // All required fields provided
    const usage: ActualTokenUsage = {
      completionTokens: input.completionTokens ?? 0,
      promptTokens: input.promptTokens ?? 0,
      totalTokens: input.totalTokens ?? 0,
      updatedAt: input.updatedAt ?? new Date(),
    };

    expect(usage.completionTokens).toBe(100);
  });

  it("PreparedCompactionSegment should be assignable to CompactionSegment", () => {
    const prepared: PreparedCompactionSegment = {
      createdAt: new Date(),
      endMessageId: "msg-10",
      estimatedTokens: 5000,
      id: "segment-123",
      messageCount: 10,
      messageIds: ["msg-1", "msg-2"],
      messages: [],
      startMessageId: "msg-1",
      summary: null,
    };

    // Structural assignment
    const compact: CompactionSegment = prepared;

    expect(compact.id).toBe("segment-123");
  });

  it("Message should be compatible in arrays", () => {
    const messages: Message[] = [
      {
        createdAt: new Date(),
        id: "msg-1",
        modelMessage: createMockModelMessage(),
      },
    ];

    // Can be used where Message[] is expected
    const segment = {
      messages: messages,
    };

    expect(segment.messages).toHaveLength(1);
  });

  it("CheckpointMessage should preserve isSummary field", () => {
    const checkpoint: CheckpointMessage = {
      createdAt: 1704067200000,
      id: "cp-123",
      isSummary: true,
      message: createMockModelMessage(),
    };

    expect(checkpoint.isSummary).toBe(true);
    // isSummary is a required boolean field
  });
});

// ============================================
// Edge Cases and Boundary Tests
// ============================================

describe("Edge Cases and Boundaries", () => {
  it("CompactionConfig should handle zero values correctly", () => {
    const config: CompactionConfig = {
      contextLimit: 0,
      keepRecentTokens: 0,
      maxTokens: 0,
      reserveTokens: 0,
      thresholdRatio: 0,
      speculativeStartRatio: 0,
    };

    expect(config.contextLimit).toBe(0);
    expect(config.keepRecentTokens).toBe(0);
    expect(config.maxTokens).toBe(0);
  });

  it("ContextUsage should handle 0% and 100% percentage", () => {
    const empty: ContextUsage = {
      limit: 1000,
      percentage: 0,
      remaining: 1000,
      source: "actual",
      used: 0,
    };

    const full: ContextUsage = {
      limit: 1000,
      percentage: 100,
      remaining: 0,
      source: "actual",
      used: 1000,
    };

    expect(empty.percentage).toBe(0);
    expect(full.percentage).toBe(100);
  });

  it("CompactionSummary should handle large token values", () => {
    const summary: CompactionSummary = {
      createdAt: new Date(),
      firstKeptMessageId: "msg-1",
      id: "large-summary",
      summary: "a".repeat(10000), // 10k character summary
      summaryTokens: 2500,
      tokensBefore: 128000,
    };

    expect(summary.summary.length).toBe(10000);
    expect(summary.tokensBefore).toBe(128000);
  });

  it("SessionFileLine should handle all three variants", () => {
    const header: SessionFileLine = {
      createdAt: 1704067200000,
      sessionId: "test-session",
      type: "header",
      version: 1,
    };

    const message: SessionFileLine = {
      createdAt: 1704067200000,
      id: "test-msg",
      isSummary: false,
      message: createMockModelMessage(),
      type: "message",
    };

    const checkpoint: SessionFileLine = {
      summaryMessageId: "test-summary",
      type: "checkpoint",
      updatedAt: 1704067200000,
    };

    expect(header.type).toBe("header");
    expect(message.type).toBe("message");
    expect(checkpoint.type).toBe("checkpoint");
  });

  it("PreparedCompaction should handle phase transition", () => {
    const intermediateStep: PreparedCompaction = {
      actualUsage: null,
      baseMessageIds: [],
      baseRevision: 1,
      baseSegmentIds: [],
      compactionMaxTokensAtCreation: 8000,
      contextLimitAtCreation: 128000,
      didChange: true,
      keepRecentTokensAtCreation: 2000,
      pendingCompaction: true,
      phase: "intermediate-step",
      rejected: false,
      segments: [],
      tokenDelta: -1000,
    };

    const newTurn: PreparedCompaction = {
      ...intermediateStep,
      phase: "new-turn",
      pendingCompaction: false,
    };

    expect(intermediateStep.phase).toBe("intermediate-step");
    expect(newTurn.phase).toBe("new-turn");
  });
});
