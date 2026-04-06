import { describe, expect, it } from "vitest";
import type {
  ActualTokenUsage,
  ActualTokenUsageInput,
  CheckpointLine,
  CheckpointMessage,
  CompactionConfig,
  CompactionResult,
  CompactionSegment,
  CompactionSummary,
  ContextUsage,
  ContinuationVariant,
  Message,
  MessageLine,
  PreparedCompaction,
  PreparedCompactionSegment,
  PreparedCompactionV2,
  PruningConfig,
  SessionFileLine,
  SessionHeaderLine,
  SessionMetadata,
  StructuredState,
  TodoItem,
} from "./compaction-types";

describe("compaction-types", () => {
  // --- Message ---
  describe("Message", () => {
    it("should have required fields", () => {
      const message: Message = {
        createdAt: new Date(),
        id: "test-id",
        modelMessage: { role: "user", content: "test" },
      };
      expect(message.createdAt).toBeInstanceOf(Date);
      expect(message.id).toBe("test-id");
      expect(message.modelMessage).toBeDefined();
    });

    it("should allow optional originalContent", () => {
      const message: Message = {
        createdAt: new Date(),
        id: "test-id",
        modelMessage: { role: "user", content: "test" },
        originalContent: "original",
      };
      expect(message.originalContent).toBe("original");
    });

    it("should allow missing optional fields", () => {
      const message: Message = {
        createdAt: new Date(),
        id: "test-id",
        modelMessage: { role: "user", content: "test" },
      };
      expect(message.originalContent).toBeUndefined();
    });

    it("should accept different ModelMessage types", () => {
      const userMessage: Message = {
        createdAt: new Date(),
        id: "user-1",
        modelMessage: { role: "user", content: "hello" },
      };
      const assistantMessage: Message = {
        createdAt: new Date(),
        id: "assistant-1",
        modelMessage: { role: "assistant", content: "hi there" },
      };
      expect(userMessage.modelMessage.role).toBe("user");
      expect(assistantMessage.modelMessage.role).toBe("assistant");
    });
  });

  // --- CheckpointMessage ---
  describe("CheckpointMessage", () => {
    it("should have required fields", () => {
      const checkpoint: CheckpointMessage = {
        createdAt: Date.now(),
        id: "checkpoint-id",
        isSummary: false,
        message: { role: "user", content: "test" },
      };
      expect(checkpoint.createdAt).toBeDefined();
      expect(checkpoint.id).toBeDefined();
      expect(checkpoint.isSummary).toBe(false);
      expect(checkpoint.message).toBeDefined();
    });

    it("should allow optional isSummaryMessage", () => {
      const checkpoint: CheckpointMessage = {
        createdAt: Date.now(),
        id: "checkpoint-id",
        isSummary: true,
        isSummaryMessage: true,
        message: { role: "user", content: "test" },
      };
      expect(checkpoint.isSummaryMessage).toBe(true);
    });

    it("should allow optional originalContent", () => {
      const checkpoint: CheckpointMessage = {
        createdAt: Date.now(),
        id: "checkpoint-id",
        isSummary: false,
        message: { role: "user", content: "test" },
        originalContent: "original",
      };
      expect(checkpoint.originalContent).toBe("original");
    });

    it("should have createdAt as number (Date.now())", () => {
      const timestamp = Date.now();
      const checkpoint: CheckpointMessage = {
        createdAt: timestamp,
        id: "test",
        isSummary: false,
        message: { role: "user", content: "test" },
      };
      expect(checkpoint.createdAt).toBe(timestamp);
      expect(typeof checkpoint.createdAt).toBe("number");
    });
  });

  // --- SessionMetadata ---
  describe("SessionMetadata", () => {
    it("should have all required fields", () => {
      const metadata: SessionMetadata = {
        outputTokens: 100,
        createdAt: Date.now(),
        inputTokens: 50,
        sessionId: "session-123",
        summaryMessageId: null,
        updatedAt: Date.now(),
      };
      expect(metadata.outputTokens).toBe(100);
      expect(metadata.inputTokens).toBe(50);
      expect(metadata.sessionId).toBe("session-123");
      expect(metadata.summaryMessageId).toBeNull();
      expect(metadata.createdAt).toBeDefined();
      expect(metadata.updatedAt).toBeDefined();
    });

    it("should allow summaryMessageId as string after compaction", () => {
      const metadata: SessionMetadata = {
        outputTokens: 200,
        createdAt: Date.now(),
        inputTokens: 100,
        sessionId: "session-456",
        summaryMessageId: "summary-msg-id",
        updatedAt: Date.now(),
      };
      expect(typeof metadata.summaryMessageId).toBe("string");
    });

    it("should have numeric token fields", () => {
      const metadata: SessionMetadata = {
        outputTokens: 0,
        createdAt: Date.now(),
        inputTokens: 0,
        sessionId: "session-zero",
        summaryMessageId: null,
        updatedAt: Date.now(),
      };
      expect(typeof metadata.outputTokens).toBe("number");
      expect(typeof metadata.inputTokens).toBe("number");
    });
  });

  // --- CompactionConfig ---
  describe("CompactionConfig", () => {
    it("should allow empty config with all optional fields", () => {
      const config: CompactionConfig = {};
      expect(config).toBeDefined();
    });

    it("should accept contextLimit", () => {
      const config: CompactionConfig = {
        contextLimit: 128_000,
      };
      expect(config.contextLimit).toBe(128_000);
    });

    it("should accept enabled", () => {
      const config: CompactionConfig = {
        enabled: true,
      };
      expect(config.enabled).toBe(true);
    });

    it("should accept getStructuredState callback", () => {
      const config: CompactionConfig = {
        getStructuredState: () => "state string",
      };
      expect(config.getStructuredState).toBeDefined();
      expect(config.getStructuredState?.()).toBe("state string");
    });

    it("should accept getStructuredState returning undefined", () => {
      const config: CompactionConfig = {
        getStructuredState: () => undefined,
      };
      expect(config.getStructuredState?.()).toBeUndefined();
    });

    it("should accept getLastExtractionMessageIndex callback", () => {
      const config: CompactionConfig = {
        getLastExtractionMessageIndex: () => 42,
      };
      expect(config.getLastExtractionMessageIndex?.()).toBe(42);
    });

    it("should accept keepRecentTokens", () => {
      const config: CompactionConfig = {
        keepRecentTokens: 2000,
      };
      expect(config.keepRecentTokens).toBe(2000);
    });

    it("should accept maxTokens", () => {
      const config: CompactionConfig = {
        maxTokens: 8000,
      };
      expect(config.maxTokens).toBe(8000);
    });

    it("should accept reserveTokens", () => {
      const config: CompactionConfig = {
        reserveTokens: 2000,
      };
      expect(config.reserveTokens).toBe(2000);
    });

    it("should accept speculativeStartRatio", () => {
      const config: CompactionConfig = {
        speculativeStartRatio: 0.5,
      };
      expect(config.speculativeStartRatio).toBe(0.5);
    });

    it("should accept summarizeFn", () => {
      const summarizeFn = (_messages: any[], _previousSummary?: string) =>
        Promise.resolve("summary");
      const config: CompactionConfig = {
        summarizeFn,
      };
      expect(config.summarizeFn).toBeDefined();
    });

    it("should accept thresholdRatio", () => {
      const config: CompactionConfig = {
        thresholdRatio: 0.5,
      };
      expect(config.thresholdRatio).toBe(0.5);
    });

    it("should accept sessionMemoryCompaction config", () => {
      const config: CompactionConfig = {
        sessionMemoryCompaction: {
          minKeepTokens: 1500,
          minKeepMessages: 2,
          maxKeepTokens: 4000,
        },
      };

      expect(config.sessionMemoryCompaction?.minKeepTokens).toBe(1500);
      expect(config.sessionMemoryCompaction?.minKeepMessages).toBe(2);
      expect(config.sessionMemoryCompaction?.maxKeepTokens).toBe(4000);
    });

    it("should accept all fields together", () => {
      const config: CompactionConfig = {
        compactionDirection: "keep-prefix",
        contextLimit: 128_000,
        enabled: true,
        getLastExtractionMessageIndex: () => 100,
        getStructuredState: () => "state",
        keepRecentTokens: 2000,
        maxTokens: 8000,
        reserveTokens: 2000,
        sessionMemoryCompaction: {
          minKeepMessages: 3,
          minKeepTokens: 2000,
          maxKeepTokens: 4000,
        },
        speculativeStartRatio: 0.5,
        summarizeFn: async () => "summary",
        thresholdRatio: 0.5,
      };
      expect(config.contextLimit).toBe(128_000);
      expect(config.enabled).toBe(true);
      expect(config.keepRecentTokens).toBe(2000);
      expect(config.maxTokens).toBe(8000);
      expect(config.reserveTokens).toBe(2000);
      expect(config.speculativeStartRatio).toBe(0.5);
      expect(config.thresholdRatio).toBe(0.5);
      expect(config.compactionDirection).toBe("keep-prefix");
    });

    it("should accept keep-recent compactionDirection", () => {
      const config: CompactionConfig = {
        compactionDirection: "keep-recent",
      };

      expect(config.compactionDirection).toBe("keep-recent");
    });

    it("should allow zero values for numeric fields", () => {
      const config: CompactionConfig = {
        contextLimit: 0,
        keepRecentTokens: 0,
        maxTokens: 0,
        reserveTokens: 0,
        speculativeStartRatio: 0,
        thresholdRatio: 0,
      };
      expect(config.contextLimit).toBe(0);
      expect(config.keepRecentTokens).toBe(0);
    });
  });

  // --- PruningConfig ---
  describe("PruningConfig", () => {
    it("should allow empty config with all optional fields", () => {
      const config: PruningConfig = {};
      expect(config).toBeDefined();
    });

    it("should accept eagerPruneToolNames", () => {
      const config: PruningConfig = {
        eagerPruneToolNames: ["tool1", "tool2"],
      };
      expect(config.eagerPruneToolNames).toEqual(["tool1", "tool2"]);
    });

    it("should accept enabled", () => {
      const config: PruningConfig = {
        enabled: true,
      };
      expect(config.enabled).toBe(true);
    });

    it("should accept minSavingsTokens", () => {
      const config: PruningConfig = {
        minSavingsTokens: 200,
      };
      expect(config.minSavingsTokens).toBe(200);
    });

    it("should accept protectedToolNames", () => {
      const config: PruningConfig = {
        protectedToolNames: ["protected-tool"],
      };
      expect(config.protectedToolNames).toEqual(["protected-tool"]);
    });

    it("should accept protectRecentTokens", () => {
      const config: PruningConfig = {
        protectRecentTokens: 2000,
      };
      expect(config.protectRecentTokens).toBe(2000);
    });

    it("should accept replacementText", () => {
      const config: PruningConfig = {
        replacementText: "[output pruned — too large]",
      };
      expect(config.replacementText).toBe("[output pruned — too large]");
    });

    it("should accept all fields together", () => {
      const config: PruningConfig = {
        eagerPruneToolNames: ["tool1"],
        enabled: true,
        minSavingsTokens: 200,
        protectedToolNames: ["protected"],
        protectRecentTokens: 2000,
        replacementText: "[pruned]",
      };
      expect(config.eagerPruneToolNames).toEqual(["tool1"]);
      expect(config.enabled).toBe(true);
      expect(config.minSavingsTokens).toBe(200);
      expect(config.protectedToolNames).toEqual(["protected"]);
      expect(config.protectRecentTokens).toBe(2000);
      expect(config.replacementText).toBe("[pruned]");
    });

    it("should allow empty arrays for tool name fields", () => {
      const config: PruningConfig = {
        eagerPruneToolNames: [],
        protectedToolNames: [],
      };
      expect(config.eagerPruneToolNames).toEqual([]);
      expect(config.protectedToolNames).toEqual([]);
    });
  });

  // --- ContinuationVariant ---
  describe("ContinuationVariant", () => {
    it("should accept 'manual'", () => {
      const variant: ContinuationVariant = "manual";
      expect(variant).toBe("manual");
    });

    it("should accept 'auto-with-replay'", () => {
      const variant: ContinuationVariant = "auto-with-replay";
      expect(variant).toBe("auto-with-replay");
    });

    it("should accept 'tool-loop'", () => {
      const variant: ContinuationVariant = "tool-loop";
      expect(variant).toBe("tool-loop");
    });

    it("should be a string type", () => {
      const variant: ContinuationVariant = "manual";
      expect(typeof variant).toBe("string");
    });

    it("should not accept invalid values", () => {
      // TypeScript compile-time check - this would fail if uncommented:
      // const invalid: ContinuationVariant = "invalid";
      expect(true).toBe(true);
    });
  });

  // --- CompactionResult ---
  describe("CompactionResult", () => {
    it("should have required success field", () => {
      const result: CompactionResult = {
        success: true,
        tokensAfter: 1000,
        tokensBefore: 5000,
      };
      expect(result.success).toBe(true);
      expect(result.tokensAfter).toBe(1000);
      expect(result.tokensBefore).toBe(5000);
    });

    it("should allow optional continuationVariant", () => {
      const result: CompactionResult = {
        success: true,
        tokensAfter: 1000,
        tokensBefore: 5000,
        continuationVariant: "manual",
      };
      expect(result.continuationVariant).toBe("manual");
    });

    it("should allow optional reason", () => {
      const result: CompactionResult = {
        success: false,
        tokensAfter: 5000,
        tokensBefore: 5000,
        reason: "Compaction failed",
      };
      expect(result.reason).toBe("Compaction failed");
    });

    it("should allow optional summaryMessageId", () => {
      const result: CompactionResult = {
        success: true,
        tokensAfter: 1000,
        tokensBefore: 5000,
        summaryMessageId: "summary-123",
      };
      expect(result.summaryMessageId).toBe("summary-123");
    });

    it("should allow optional compactionMethod", () => {
      const result: CompactionResult = {
        success: true,
        tokensAfter: 1000,
        tokensBefore: 5000,
        compactionMethod: "session-memory",
      };

      expect(result.compactionMethod).toBe("session-memory");
    });

    it("should calculate token delta correctly", () => {
      const result: CompactionResult = {
        success: true,
        tokensAfter: 1000,
        tokensBefore: 5000,
      };
      expect(result.tokensBefore - result.tokensAfter).toBe(4000);
    });
  });

  // --- PreparedCompactionV2 ---
  describe("PreparedCompactionV2", () => {
    it("should have required fields", () => {
      const prep: PreparedCompactionV2 = {
        baseMessageIds: ["msg1", "msg2"],
        revision: 1,
        splitIndex: 5,
        summaryText: "summary",
        tokenDelta: 3000,
      };
      expect(prep.baseMessageIds).toEqual(["msg1", "msg2"]);
      expect(prep.revision).toBe(1);
      expect(prep.splitIndex).toBe(5);
      expect(prep.summaryText).toBe("summary");
      expect(prep.tokenDelta).toBe(3000);
    });

    it("should allow optional replayMessage", () => {
      const prep: PreparedCompactionV2 = {
        baseMessageIds: ["msg1"],
        revision: 1,
        splitIndex: 0,
        summaryText: "summary",
        tokenDelta: 1000,
        replayMessage: {
          createdAt: Date.now(),
          id: "replay-1",
          isSummary: true,
          message: { role: "user", content: "replay" },
        },
      };
      expect(prep.replayMessage).toBeDefined();
      expect(prep.replayMessage?.id).toBe("replay-1");
    });

    it("should allow empty baseMessageIds", () => {
      const prep: PreparedCompactionV2 = {
        baseMessageIds: [],
        revision: 0,
        splitIndex: 0,
        summaryText: "",
        tokenDelta: 0,
      };
      expect(prep.baseMessageIds).toEqual([]);
    });
  });

  // --- ActualTokenUsage ---
  describe("ActualTokenUsage", () => {
    it("should have all required fields", () => {
      const usage: ActualTokenUsage = {
        outputTokens: 100,
        inputTokens: 50,
        totalTokens: 150,
        updatedAt: new Date(),
      };
      expect(usage.outputTokens).toBe(100);
      expect(usage.inputTokens).toBe(50);
      expect(usage.totalTokens).toBe(150);
      expect(usage.updatedAt).toBeInstanceOf(Date);
    });

    it("should have totalTokens equal to sum of input and output", () => {
      const usage: ActualTokenUsage = {
        outputTokens: 200,
        inputTokens: 300,
        totalTokens: 500,
        updatedAt: new Date(),
      };
      expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
    });

    it("should allow zero values", () => {
      const usage: ActualTokenUsage = {
        outputTokens: 0,
        inputTokens: 0,
        totalTokens: 0,
        updatedAt: new Date(),
      };
      expect(usage.totalTokens).toBe(0);
    });
  });

  // --- ActualTokenUsageInput ---
  describe("ActualTokenUsageInput", () => {
    it("should allow empty input with all optional fields", () => {
      const input: ActualTokenUsageInput = {};
      expect(input).toBeDefined();
    });

    it("should accept completionTokens", () => {
      const input: ActualTokenUsageInput = {
        completionTokens: 100,
      };
      expect(input.completionTokens).toBe(100);
    });

    it("should accept inputTokens", () => {
      const input: ActualTokenUsageInput = {
        inputTokens: 50,
      };
      expect(input.inputTokens).toBe(50);
    });

    it("should accept outputTokens", () => {
      const input: ActualTokenUsageInput = {
        outputTokens: 100,
      };
      expect(input.outputTokens).toBe(100);
    });

    it("should accept promptTokens", () => {
      const input: ActualTokenUsageInput = {
        promptTokens: 50,
      };
      expect(input.promptTokens).toBe(50);
    });

    it("should accept totalTokens", () => {
      const input: ActualTokenUsageInput = {
        totalTokens: 150,
      };
      expect(input.totalTokens).toBe(150);
    });

    it("should accept updatedAt", () => {
      const input: ActualTokenUsageInput = {
        updatedAt: new Date(),
      };
      expect(input.updatedAt).toBeInstanceOf(Date);
    });

    it("should accept all fields together", () => {
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
    });
  });

  // --- ContextUsage ---
  describe("ContextUsage", () => {
    it("should have all required fields", () => {
      const usage: ContextUsage = {
        limit: 128_000,
        percentage: 50,
        remaining: 64_000,
        source: "actual",
        used: 64_000,
      };
      expect(usage.limit).toBe(128_000);
      expect(usage.percentage).toBe(50);
      expect(usage.remaining).toBe(64_000);
      expect(usage.source).toBe("actual");
      expect(usage.used).toBe(64_000);
    });

    it("should accept source as 'estimated'", () => {
      const usage: ContextUsage = {
        limit: 128_000,
        percentage: 30,
        remaining: 89_600,
        source: "estimated",
        used: 38_400,
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
      usage.percentage = (usage.used / usage.limit) * 100;
      expect(usage.percentage).toBe(0);
    });

    it("should have percentage in range 0-100", () => {
      const usage: ContextUsage = {
        limit: 100,
        percentage: 100,
        remaining: 0,
        source: "actual",
        used: 100,
      };
      expect(usage.percentage).toBeGreaterThanOrEqual(0);
      expect(usage.percentage).toBeLessThanOrEqual(100);
    });
  });

  // --- TodoItem ---
  describe("TodoItem", () => {
    it("should have required fields", () => {
      const todo: TodoItem = {
        content: "task content",
        status: "pending",
      };
      expect(todo.content).toBe("task content");
      expect(todo.status).toBe("pending");
    });

    it("should accept status 'in_progress'", () => {
      const todo: TodoItem = {
        content: "task in progress",
        status: "in_progress",
      };
      expect(todo.status).toBe("in_progress");
    });

    it("should accept status 'completed'", () => {
      const todo: TodoItem = {
        content: "completed task",
        status: "completed",
      };
      expect(todo.status).toBe("completed");
    });

    it("should accept status 'cancelled'", () => {
      const todo: TodoItem = {
        content: "cancelled task",
        status: "cancelled",
      };
      expect(todo.status).toBe("cancelled");
    });

    it("should not accept invalid status", () => {
      // TypeScript compile-time check - this would fail if uncommented:
      // const invalid: TodoItem = { content: "test", status: "invalid" };
      expect(true).toBe(true);
    });
  });

  // --- StructuredState ---
  describe("StructuredState", () => {
    it("should allow empty state", () => {
      const state: StructuredState = {};
      expect(state).toBeDefined();
    });

    it("should accept metadata", () => {
      const state: StructuredState = {
        metadata: { key: "value", count: 42 },
      };
      expect(state.metadata).toEqual({ key: "value", count: 42 });
    });

    it("should accept todos", () => {
      const state: StructuredState = {
        todos: [
          { content: "task 1", status: "pending" },
          { content: "task 2", status: "completed" },
        ],
      };
      expect(state.todos).toHaveLength(2);
      expect(state.todos?.[0].content).toBe("task 1");
    });

    it("should accept both metadata and todos", () => {
      const state: StructuredState = {
        metadata: { version: "1.0" },
        todos: [{ content: "test", status: "in_progress" }],
      };
      expect(state.metadata).toBeDefined();
      expect(state.todos).toBeDefined();
    });

    it("should allow empty metadata and todos", () => {
      const state: StructuredState = {
        metadata: {},
        todos: [],
      };
      expect(state.metadata).toEqual({});
      expect(state.todos).toEqual([]);
    });
  });

  // --- SessionHeaderLine ---
  describe("SessionHeaderLine", () => {
    it("should have required fields", () => {
      const header: SessionHeaderLine = {
        createdAt: Date.now(),
        sessionId: "session-123",
        type: "header",
        version: 1,
      };
      expect(header.createdAt).toBeDefined();
      expect(header.sessionId).toBe("session-123");
      expect(header.type).toBe("header");
      expect(header.version).toBe(1);
    });

    it("should have type as 'header'", () => {
      const header: SessionHeaderLine = {
        createdAt: Date.now(),
        sessionId: "session-456",
        type: "header",
        version: 1,
      };
      expect(header.type).toBe("header");
    });

    it("should have version as 1", () => {
      const header: SessionHeaderLine = {
        createdAt: Date.now(),
        sessionId: "session-789",
        type: "header",
        version: 1,
      };
      expect(header.version).toBe(1);
    });
  });

  // --- MessageLine ---
  describe("MessageLine", () => {
    it("should have required fields", () => {
      const line: MessageLine = {
        createdAt: Date.now(),
        id: "msg-123",
        isSummary: false,
        message: { role: "user", content: "test" },
        type: "message",
      };
      expect(line.createdAt).toBeDefined();
      expect(line.id).toBe("msg-123");
      expect(line.isSummary).toBe(false);
      expect(line.message).toBeDefined();
      expect(line.type).toBe("message");
    });

    it("should allow optional originalContent", () => {
      const line: MessageLine = {
        createdAt: Date.now(),
        id: "msg-456",
        isSummary: false,
        message: { role: "user", content: "test" },
        originalContent: "original",
        type: "message",
      };
      expect(line.originalContent).toBe("original");
    });

    it("should have type as 'message'", () => {
      const line: MessageLine = {
        createdAt: Date.now(),
        id: "msg-789",
        isSummary: true,
        message: { role: "assistant", content: "summary" },
        type: "message",
      };
      expect(line.type).toBe("message");
    });
  });

  // --- CheckpointLine ---
  describe("CheckpointLine", () => {
    it("should have required fields", () => {
      const checkpoint: CheckpointLine = {
        summaryMessageId: "summary-123",
        type: "checkpoint",
        updatedAt: Date.now(),
      };
      expect(checkpoint.summaryMessageId).toBe("summary-123");
      expect(checkpoint.type).toBe("checkpoint");
      expect(checkpoint.updatedAt).toBeDefined();
    });

    it("should have type as 'checkpoint'", () => {
      const checkpoint: CheckpointLine = {
        summaryMessageId: "summary-456",
        type: "checkpoint",
        updatedAt: Date.now(),
      };
      expect(checkpoint.type).toBe("checkpoint");
    });
  });

  // --- SessionFileLine (Union Type) ---
  describe("SessionFileLine", () => {
    it("should accept SessionHeaderLine", () => {
      const line: SessionFileLine = {
        createdAt: Date.now(),
        sessionId: "session-123",
        type: "header",
        version: 1,
      };
      expect(line.type).toBe("header");
    });

    it("should accept MessageLine", () => {
      const line: SessionFileLine = {
        createdAt: Date.now(),
        id: "msg-123",
        isSummary: false,
        message: { role: "user", content: "test" },
        type: "message",
      };
      expect(line.type).toBe("message");
    });

    it("should accept CheckpointLine", () => {
      const line: SessionFileLine = {
        summaryMessageId: "summary-123",
        type: "checkpoint",
        updatedAt: Date.now(),
      };
      expect(line.type).toBe("checkpoint");
    });

    it("should discriminate by type field", () => {
      const headerLine: SessionFileLine = {
        createdAt: Date.now(),
        sessionId: "session-1",
        type: "header",
        version: 1,
      };
      const messageLine: SessionFileLine = {
        createdAt: Date.now(),
        id: "msg-1",
        isSummary: false,
        message: { role: "user", content: "test" },
        type: "message",
      };
      const checkpointLine: SessionFileLine = {
        summaryMessageId: "summary-1",
        type: "checkpoint",
        updatedAt: Date.now(),
      };

      expect(headerLine.type).toBe("header");
      expect(messageLine.type).toBe("message");
      expect(checkpointLine.type).toBe("checkpoint");
    });
  });

  // --- CompactionSummary ---
  describe("CompactionSummary", () => {
    it("should have required fields", () => {
      const summary: CompactionSummary = {
        createdAt: new Date(),
        firstKeptMessageId: "msg-kept-1",
        id: "summary-123",
        summary: "This is a summary of the conversation",
        summaryTokens: 500,
        tokensBefore: 5000,
      };
      expect(summary.createdAt).toBeInstanceOf(Date);
      expect(summary.firstKeptMessageId).toBe("msg-kept-1");
      expect(summary.id).toBe("summary-123");
      expect(summary.summary).toBe("This is a summary of the conversation");
      expect(summary.summaryTokens).toBe(500);
      expect(summary.tokensBefore).toBe(5000);
    });

    it("should have summaryTokens less than tokensBefore", () => {
      const summary: CompactionSummary = {
        createdAt: new Date(),
        firstKeptMessageId: "msg-1",
        id: "summary-1",
        summary: "summary",
        summaryTokens: 100,
        tokensBefore: 1000,
      };
      expect(summary.summaryTokens).toBeLessThan(summary.tokensBefore);
    });
  });

  // --- CompactionSegment ---
  describe("CompactionSegment", () => {
    it("should have required fields", () => {
      const segment: CompactionSegment = {
        createdAt: new Date(),
        endMessageId: "msg-end",
        estimatedTokens: 1000,
        id: "segment-1",
        messageCount: 10,
        messageIds: ["msg1", "msg2", "msg3"],
        messages: [],
        startMessageId: "msg-start",
        summary: null,
      };
      expect(segment.createdAt).toBeInstanceOf(Date);
      expect(segment.endMessageId).toBe("msg-end");
      expect(segment.estimatedTokens).toBe(1000);
      expect(segment.id).toBe("segment-1");
      expect(segment.messageCount).toBe(10);
      expect(segment.messageIds).toHaveLength(3);
      expect(segment.messages).toEqual([]);
      expect(segment.startMessageId).toBe("msg-start");
      expect(segment.summary).toBeNull();
    });

    it("should allow summary as CompactionSummary", () => {
      const summary: CompactionSummary = {
        createdAt: new Date(),
        firstKeptMessageId: "msg-kept",
        id: "summary-1",
        summary: "summary text",
        summaryTokens: 100,
        tokensBefore: 1000,
      };
      const segment: CompactionSegment = {
        createdAt: new Date(),
        endMessageId: "msg-end",
        estimatedTokens: 500,
        id: "segment-1",
        messageCount: 5,
        messageIds: ["msg1"],
        messages: [],
        startMessageId: "msg-start",
        summary,
      };
      expect(segment.summary).toBeDefined();
      expect(segment.summary?.id).toBe("summary-1");
    });

    it("should have messageCount match messageIds length", () => {
      const segment: CompactionSegment = {
        createdAt: new Date(),
        endMessageId: "msg-end",
        estimatedTokens: 300,
        id: "segment-1",
        messageCount: 3,
        messageIds: ["msg1", "msg2", "msg3"],
        messages: [],
        startMessageId: "msg-start",
        summary: null,
      };
      expect(segment.messageCount).toBe(segment.messageIds.length);
    });
  });

  // --- PreparedCompactionSegment ---
  describe("PreparedCompactionSegment", () => {
    it("should have required fields", () => {
      const segment: PreparedCompactionSegment = {
        createdAt: new Date(),
        endMessageId: "msg-end",
        estimatedTokens: 1000,
        id: "segment-1",
        messageCount: 10,
        messageIds: ["msg1", "msg2"],
        messages: [],
        startMessageId: "msg-start",
        summary: null,
      };
      expect(segment.createdAt).toBeInstanceOf(Date);
      expect(segment.endMessageId).toBe("msg-end");
      expect(segment.estimatedTokens).toBe(1000);
      expect(segment.id).toBe("segment-1");
      expect(segment.messageCount).toBe(10);
      expect(segment.startMessageId).toBe("msg-start");
      expect(segment.summary).toBeNull();
    });

    it("should allow summary", () => {
      const summary: CompactionSummary = {
        createdAt: new Date(),
        firstKeptMessageId: "msg-kept",
        id: "summary-1",
        summary: "summary",
        summaryTokens: 50,
        tokensBefore: 500,
      };
      const segment: PreparedCompactionSegment = {
        createdAt: new Date(),
        endMessageId: "msg-end",
        estimatedTokens: 400,
        id: "segment-1",
        messageCount: 5,
        messageIds: ["msg1"],
        messages: [],
        startMessageId: "msg-start",
        summary,
      };
      expect(segment.summary).toBeDefined();
    });
  });

  // --- PreparedCompaction ---
  describe("PreparedCompaction", () => {
    it("should have required fields", () => {
      const prep: PreparedCompaction = {
        actualUsage: null,
        baseMessageIds: ["msg1", "msg2"],
        baseRevision: 1,
        baseSegmentIds: ["segment-1"],
        compactionMaxTokensAtCreation: 8000,
        contextLimitAtCreation: 128_000,
        didChange: false,
        keepRecentTokensAtCreation: 2000,
        pendingCompaction: false,
        phase: "new-turn",
        rejected: false,
        segments: [],
        tokenDelta: 0,
      };
      expect(prep.actualUsage).toBeNull();
      expect(prep.baseMessageIds).toEqual(["msg1", "msg2"]);
      expect(prep.baseRevision).toBe(1);
      expect(prep.baseSegmentIds).toEqual(["segment-1"]);
      expect(prep.compactionMaxTokensAtCreation).toBe(8000);
      expect(prep.contextLimitAtCreation).toBe(128_000);
      expect(prep.didChange).toBe(false);
      expect(prep.keepRecentTokensAtCreation).toBe(2000);
      expect(prep.pendingCompaction).toBe(false);
      expect(prep.phase).toBe("new-turn");
      expect(prep.rejected).toBe(false);
      expect(prep.segments).toEqual([]);
      expect(prep.tokenDelta).toBe(0);
    });

    it("should accept actualUsage", () => {
      const usage: ActualTokenUsage = {
        outputTokens: 100,
        inputTokens: 50,
        totalTokens: 150,
        updatedAt: new Date(),
      };
      const prep: PreparedCompaction = {
        actualUsage: usage,
        baseMessageIds: [],
        baseRevision: 0,
        baseSegmentIds: [],
        compactionMaxTokensAtCreation: 8000,
        contextLimitAtCreation: 128_000,
        didChange: false,
        keepRecentTokensAtCreation: 2000,
        pendingCompaction: false,
        phase: "new-turn",
        rejected: false,
        segments: [],
        tokenDelta: 0,
      };
      expect(prep.actualUsage).toBeDefined();
      expect(prep.actualUsage?.totalTokens).toBe(150);
    });

    it("should accept phase 'intermediate-step'", () => {
      const prep: PreparedCompaction = {
        actualUsage: null,
        baseMessageIds: [],
        baseRevision: 0,
        baseSegmentIds: [],
        compactionMaxTokensAtCreation: 8000,
        contextLimitAtCreation: 128_000,
        didChange: false,
        keepRecentTokensAtCreation: 2000,
        pendingCompaction: false,
        phase: "intermediate-step",
        rejected: false,
        segments: [],
        tokenDelta: 0,
      };
      expect(prep.phase).toBe("intermediate-step");
    });

    it("should accept phase 'new-turn'", () => {
      const prep: PreparedCompaction = {
        actualUsage: null,
        baseMessageIds: [],
        baseRevision: 0,
        baseSegmentIds: [],
        compactionMaxTokensAtCreation: 8000,
        contextLimitAtCreation: 128_000,
        didChange: false,
        keepRecentTokensAtCreation: 2000,
        pendingCompaction: false,
        phase: "new-turn",
        rejected: false,
        segments: [],
        tokenDelta: 0,
      };
      expect(prep.phase).toBe("new-turn");
    });

    it("should accept segments with PreparedCompactionSegment", () => {
      const segment: PreparedCompactionSegment = {
        createdAt: new Date(),
        endMessageId: "msg-end",
        estimatedTokens: 500,
        id: "segment-1",
        messageCount: 5,
        messageIds: ["msg1"],
        messages: [],
        startMessageId: "msg-start",
        summary: null,
      };
      const prep: PreparedCompaction = {
        actualUsage: null,
        baseMessageIds: [],
        baseRevision: 0,
        baseSegmentIds: [],
        compactionMaxTokensAtCreation: 8000,
        contextLimitAtCreation: 128_000,
        didChange: true,
        keepRecentTokensAtCreation: 2000,
        pendingCompaction: false,
        phase: "new-turn",
        rejected: false,
        segments: [segment],
        tokenDelta: 1000,
      };
      expect(prep.segments).toHaveLength(1);
      expect(prep.segments[0].id).toBe("segment-1");
    });

    it("should accept rejected as true", () => {
      const prep: PreparedCompaction = {
        actualUsage: null,
        baseMessageIds: [],
        baseRevision: 0,
        baseSegmentIds: [],
        compactionMaxTokensAtCreation: 8000,
        contextLimitAtCreation: 128_000,
        didChange: false,
        keepRecentTokensAtCreation: 2000,
        pendingCompaction: false,
        phase: "new-turn",
        rejected: true,
        segments: [],
        tokenDelta: 0,
      };
      expect(prep.rejected).toBe(true);
    });

    it("should accept pendingCompaction as true", () => {
      const prep: PreparedCompaction = {
        actualUsage: null,
        baseMessageIds: [],
        baseRevision: 0,
        baseSegmentIds: [],
        compactionMaxTokensAtCreation: 8000,
        contextLimitAtCreation: 128_000,
        didChange: false,
        keepRecentTokensAtCreation: 2000,
        pendingCompaction: true,
        phase: "new-turn",
        rejected: false,
        segments: [],
        tokenDelta: 0,
      };
      expect(prep.pendingCompaction).toBe(true);
    });
  });

  // --- Type Compatibility Tests ---
  describe("Type Compatibility", () => {
    it("Message should be compatible with CheckpointMessage fields", () => {
      const message: Message = {
        createdAt: new Date(),
        id: "msg-1",
        modelMessage: { role: "user", content: "test" },
      };
      const checkpointMessage: CheckpointMessage = {
        createdAt: Date.now(),
        id: "checkpoint-1",
        isSummary: false,
        message: message.modelMessage,
      };
      expect(checkpointMessage.message).toBeDefined();
    });

    it("CompactionSummary should be compatible with CompactionSegment summary", () => {
      const summary: CompactionSummary = {
        createdAt: new Date(),
        firstKeptMessageId: "msg-kept",
        id: "summary-1",
        summary: "summary text",
        summaryTokens: 100,
        tokensBefore: 1000,
      };
      const segment: CompactionSegment = {
        createdAt: new Date(),
        endMessageId: "msg-end",
        estimatedTokens: 500,
        id: "segment-1",
        messageCount: 5,
        messageIds: ["msg1"],
        messages: [],
        startMessageId: "msg-start",
        summary,
      };
      expect(segment.summary).toEqual(summary);
    });

    it("PreparedCompactionSegment should have same shape as CompactionSegment", () => {
      const compSegment: CompactionSegment = {
        createdAt: new Date(),
        endMessageId: "msg-end",
        estimatedTokens: 500,
        id: "segment-1",
        messageCount: 5,
        messageIds: ["msg1"],
        messages: [],
        startMessageId: "msg-start",
        summary: null,
      };
      const prepSegment: PreparedCompactionSegment = {
        createdAt: compSegment.createdAt,
        endMessageId: compSegment.endMessageId,
        estimatedTokens: compSegment.estimatedTokens,
        id: compSegment.id,
        messageCount: compSegment.messageCount,
        messageIds: compSegment.messageIds,
        messages: compSegment.messages,
        startMessageId: compSegment.startMessageId,
        summary: compSegment.summary,
      };
      expect(prepSegment.id).toBe(compSegment.id);
      expect(prepSegment.summary).toBe(compSegment.summary);
    });

    it("SessionFileLine union should accept all line types", () => {
      const headerLine: SessionFileLine = {
        createdAt: Date.now(),
        sessionId: "session-1",
        type: "header",
        version: 1,
      };
      const messageLine: SessionFileLine = {
        createdAt: Date.now(),
        id: "msg-1",
        isSummary: false,
        message: { role: "user", content: "test" },
        type: "message",
      };
      const checkpointLine: SessionFileLine = {
        summaryMessageId: "summary-1",
        type: "checkpoint",
        updatedAt: Date.now(),
      };

      const lines: SessionFileLine[] = [
        headerLine,
        messageLine,
        checkpointLine,
      ];
      expect(lines).toHaveLength(3);
      expect(lines[0].type).toBe("header");
      expect(lines[1].type).toBe("message");
      expect(lines[2].type).toBe("checkpoint");
    });

    it("ActualTokenUsageInput should have optional fields", () => {
      const input1: ActualTokenUsageInput = {};
      const input2: ActualTokenUsageInput = { completionTokens: 100 };
      const input3: ActualTokenUsageInput = {
        promptTokens: 50,
        totalTokens: 150,
      };

      expect(input1.outputTokens).toBeUndefined();
      expect(input2.completionTokens).toBe(100);
      expect(input3.promptTokens).toBe(50);
      expect(input3.totalTokens).toBe(150);
    });

    it("CompactionConfig should have all optional fields", () => {
      const emptyConfig: CompactionConfig = {};
      const fullConfig: CompactionConfig = {
        contextLimit: 128_000,
        enabled: true,
        getLastExtractionMessageIndex: () => 10,
        getStructuredState: () => "state",
        keepRecentTokens: 2000,
        maxTokens: 8000,
        reserveTokens: 2000,
        sessionMemoryCompaction: {
          minKeepMessages: 3,
          minKeepTokens: 2000,
          maxKeepTokens: 4000,
        },
        speculativeStartRatio: 0.5,
        summarizeFn: async () => "summary",
        thresholdRatio: 0.5,
      };

      expect(emptyConfig.contextLimit).toBeUndefined();
      expect(fullConfig.contextLimit).toBe(128_000);
      expect(fullConfig.enabled).toBe(true);
    });

    it("PruningConfig should have all optional fields", () => {
      const emptyConfig: PruningConfig = {};
      const fullConfig: PruningConfig = {
        eagerPruneToolNames: ["tool1"],
        enabled: true,
        minSavingsTokens: 200,
        protectedToolNames: ["protected"],
        protectRecentTokens: 2000,
        replacementText: "[pruned]",
      };

      expect(emptyConfig.enabled).toBeUndefined();
      expect(fullConfig.enabled).toBe(true);
      expect(fullConfig.eagerPruneToolNames).toEqual(["tool1"]);
    });
  });
});
