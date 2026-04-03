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

function getPromptText(callPrompt: unknown): string {
  if (!Array.isArray(callPrompt)) {
    return "";
  }

  return callPrompt
    .map((message: any) => {
      if (!message || typeof message !== "object") {
        return "";
      }

      if (typeof message.content === "string") {
        return message.content;
      }

      if (!Array.isArray(message.content)) {
        return "";
      }

      return message.content
        .map((part: any) =>
          typeof part === "object" && part !== null && "text" in part
            ? String(part.text)
            : ""
        )
        .join(" ");
    })
    .join("\n");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSectionBody(
  notes: string,
  sectionName: string
): string | undefined {
  const escapedName = escapeRegExp(sectionName);
  const sectionRegex = new RegExp(
    `^#\\s+${escapedName}\\s*$\\n([\\s\\S]*?)(?=^#\\s+|$)`,
    "m"
  );
  const match = notes.match(sectionRegex);
  return match ? match[1].trim() : undefined;
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

  it("supports full replacement when incremental mode is disabled", async () => {
    const expectedMemory = `${CHAT_MEMORY_PRESET.template}\n\n- full replacement when incremental is off`;
    const model = createMockModel(`<memory>${expectedMemory}</memory>`);
    const store = new InMemoryStore();
    const extractor = new BackgroundMemoryExtractor({
      incremental: false,
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
      content: "Please keep this remembered.",
    });

    await extractor.onTurnComplete(messages, {
      inputTokens: 1,
      outputTokens: 0,
    });

    expect(await store.read()).toBe(expectedMemory);
  });

  it("incremental mode updates only targeted sections and preserves unchanged sections", async () => {
    const model = createMockModel(
      '<update section="Current Topic">- Implementing incremental notes updates.</update>'
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

    const before = await extractor.getMemoryContent();
    const userProfileBefore = getSectionBody(before, "User Profile");
    const importantDetailsBefore = getSectionBody(before, "Important Details");

    await extractor.onTurnComplete(
      makeCheckpointMessages({
        role: "user",
        content: "Let's focus on implementing incremental memory updates.",
      }),
      {
        inputTokens: 1,
        outputTokens: 0,
      }
    );

    const updated = await store.read();
    expect(getSectionBody(updated, "Current Topic")).toBe(
      "- Implementing incremental notes updates."
    );
    expect(getSectionBody(updated, "User Profile")).toBe(userProfileBefore);
    expect(getSectionBody(updated, "Important Details")).toBe(
      importantDetailsBefore
    );
  });

  it("falls back to full replacement when incremental response has no update tags", async () => {
    const fallbackMemory = `${CHAT_MEMORY_PRESET.template}\n\n- fallback full replacement`;
    const model = createMockModel(fallbackMemory);
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

    await extractor.onTurnComplete(
      makeCheckpointMessages({ role: "user", content: "Track this update" }),
      {
        inputTokens: 1,
        outputTokens: 0,
      }
    );

    expect(await store.read()).toBe(fallbackMemory);
  });

  it("sends only messages since last extraction for incremental updates", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV3({
      doGenerate: (_options: LanguageModelV3CallOptions) => {
        callCount += 1;
        const responseText =
          callCount === 1
            ? '<update section="Current Topic">- First update</update>'
            : '<update section="Current Topic">- Second update</update>';
        return Promise.resolve(createGenerateResult(responseText));
      },
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

    const firstMessages = makeCheckpointMessages({
      role: "user",
      content: "First memory fact",
    });
    await extractor.onTurnComplete(firstMessages, {
      inputTokens: 1,
      outputTokens: 0,
    });

    const secondMessages = makeCheckpointMessages(
      { role: "user", content: "First memory fact" },
      { role: "assistant", content: "Acknowledged" },
      { role: "user", content: "Second memory fact" }
    );
    await extractor.onTurnComplete(secondMessages, {
      inputTokens: 1,
      outputTokens: 0,
    });

    expect(model.doGenerateCalls).toHaveLength(2);

    const firstPromptText = getPromptText(model.doGenerateCalls[0].prompt);
    const secondPromptText = getPromptText(model.doGenerateCalls[1].prompt);

    expect(firstPromptText).toContain("First memory fact");
    expect(secondPromptText).toContain("Second memory fact");
    expect(secondPromptText).not.toContain("First memory fact");
  });
});
