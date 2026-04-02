import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { BackgroundMemoryExtractor } from "./background-memory-extractor";
import type { CheckpointMessage } from "./compaction-types";
import { CHAT_MEMORY_PRESET } from "./memory-presets";
import { InMemoryStore } from "./memory-store";

function createGenerateResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: {
        total: 100,
        noCache: 100,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: {
        total: 50,
        text: 50,
        reasoning: 0,
      },
    },
    warnings: [],
  };
}

function createMockModel(responseText: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: createGenerateResult(responseText),
  });
}

function makeCheckpointMessages(
  ...specs: Array<{
    content: string;
    role: "assistant" | "user";
  }>
): CheckpointMessage[] {
  return specs.map((spec, index) => {
    const message: ModelMessage =
      spec.role === "user"
        ? { role: "user", content: spec.content }
        : { role: "assistant", content: spec.content };

    return {
      id: `message-${index + 1}`,
      createdAt: index + 1,
      isSummary: false,
      message,
    };
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: ((value: T) => void) | undefined;

  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });

  if (!resolve) {
    throw new Error("Deferred promise resolver was not initialized");
  }

  return { promise, resolve };
}

describe("BackgroundMemoryExtractor", () => {
  it("returns undefined structured state before first extraction", async () => {
    const extractor = new BackgroundMemoryExtractor({
      model: createMockModel("<memory>unused</memory>"),
      store: new InMemoryStore(),
      preset: "chat",
    });

    expect(extractor.getStructuredState()).toBeUndefined();
    expect(await extractor.getMemoryContent()).toBe(
      CHAT_MEMORY_PRESET.template
    );
  });

  it("triggers extraction only when token and turn thresholds are both met", async () => {
    const model = createMockModel("<memory># User Profile\nAlice</memory>");
    const extractor = new BackgroundMemoryExtractor({
      model,
      store: new InMemoryStore(),
      preset: "chat",
      thresholds: {
        minTokenGrowth: 200,
        minTurns: 2,
      },
    });

    const messages = makeCheckpointMessages({ role: "user", content: "Hello" });

    await extractor.onTurnComplete(messages, {
      inputTokens: 120,
      outputTokens: 50,
    });
    expect(model.doGenerateCalls).toHaveLength(0);

    await extractor.onTurnComplete(messages, {
      inputTokens: 20,
      outputTokens: 20,
    });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("respects both thresholds before extraction", async () => {
    const highTokenModel = createMockModel("<memory>token case</memory>");
    const highTokenExtractor = new BackgroundMemoryExtractor({
      model: highTokenModel,
      store: new InMemoryStore(),
      preset: "chat",
      thresholds: {
        minTokenGrowth: 100,
        minTurns: 3,
      },
    });

    const messages = makeCheckpointMessages({ role: "user", content: "Work" });

    await highTokenExtractor.onTurnComplete(messages, {
      inputTokens: 100,
      outputTokens: 0,
    });
    await highTokenExtractor.onTurnComplete(messages, {
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(highTokenModel.doGenerateCalls).toHaveLength(0);

    await highTokenExtractor.onTurnComplete(messages, {
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(highTokenModel.doGenerateCalls).toHaveLength(1);

    const highTurnModel = createMockModel("<memory>turn case</memory>");
    const highTurnExtractor = new BackgroundMemoryExtractor({
      model: highTurnModel,
      store: new InMemoryStore(),
      preset: "chat",
      thresholds: {
        minTokenGrowth: 300,
        minTurns: 2,
      },
    });

    await highTurnExtractor.onTurnComplete(messages, {
      inputTokens: 100,
      outputTokens: 0,
    });
    await highTurnExtractor.onTurnComplete(messages, {
      inputTokens: 100,
      outputTokens: 0,
    });
    expect(highTurnModel.doGenerateCalls).toHaveLength(0);

    await highTurnExtractor.onTurnComplete(messages, {
      inputTokens: 100,
      outputTokens: 0,
    });
    expect(highTurnModel.doGenerateCalls).toHaveLength(1);
  });

  it("applies single-flight guard to avoid concurrent extractions", async () => {
    const deferred = createDeferred<LanguageModelV3GenerateResult>();
    const model = new MockLanguageModelV3({
      doGenerate: async (_options: LanguageModelV3CallOptions) =>
        deferred.promise,
    });
    const extractor = new BackgroundMemoryExtractor({
      model,
      store: new InMemoryStore(),
      preset: "chat",
      thresholds: {
        minTokenGrowth: 1,
        minTurns: 1,
      },
    });

    const messages = makeCheckpointMessages({ role: "user", content: "Run" });
    await extractor.getMemoryContent();

    const first = extractor.onTurnComplete(messages, {
      inputTokens: 1,
      outputTokens: 0,
    });
    const second = extractor.onTurnComplete(messages, {
      inputTokens: 1,
      outputTokens: 0,
    });

    deferred.resolve(createGenerateResult("<memory>single flight</memory>"));
    await Promise.all([first, second]);

    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("stores extracted memory and returns cached structured state", async () => {
    const expectedMemory = `${CHAT_MEMORY_PRESET.template}\n\n- remembered preference: dark mode`;
    const model = createMockModel(
      `<analysis>ignore</analysis><memory>${expectedMemory}</memory>`
    );
    const store = new InMemoryStore();
    const extractor = new BackgroundMemoryExtractor({
      model,
      store,
      preset: "chat",
      thresholds: {
        minTokenGrowth: 1,
        minTurns: 1,
      },
    });

    const messages = makeCheckpointMessages({
      role: "user",
      content: "Remember that I prefer dark mode.",
    });

    await extractor.onTurnComplete(messages, {
      inputTokens: 1,
      outputTokens: 0,
    });

    expect(await store.read()).toBe(expectedMemory);
    expect(await extractor.getMemoryContent()).toBe(expectedMemory);
    expect(extractor.getStructuredState()).toBe(expectedMemory);
  });
});
