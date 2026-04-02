import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { CheckpointMessage } from "./compaction-types";
import {
  CHAT_MEMORY_PRESET,
  CODE_MEMORY_PRESET,
  type MemoryPreset,
} from "./memory-presets";
import type { MemoryStore } from "./memory-store";
import { estimateMessageTokens, estimateTokens } from "./token-utils";

export interface BackgroundMemoryExtractorConfig {
  maxExtractionTokens?: number;
  model: LanguageModel;
  preset: "chat" | "code" | MemoryPreset;
  store: MemoryStore;
  thresholds?: {
    minTokenGrowth?: number;
    minTurns?: number;
  };
}

const CHAT_DEFAULT_MIN_TOKEN_GROWTH = 500;
const CODE_DEFAULT_MIN_TOKEN_GROWTH = 5000;
const DEFAULT_MIN_TURNS = 3;
const CHAT_DEFAULT_MAX_EXTRACTION_TOKENS = 1000;
const CODE_DEFAULT_MAX_EXTRACTION_TOKENS = 4000;
const DEFAULT_MESSAGE_TOKEN_BUDGET = 8000;
const CHAT_MESSAGE_TOKEN_BUDGET = 4000;
const CODE_MESSAGE_TOKEN_BUDGET = 16_000;
const MEMORY_TAG_REGEX = /<memory>([\s\S]*?)<\/memory>/i;
const CURRENT_NOTES_CLOSE_TAG_REGEX = /<\/current_notes>/gi;

interface ResolvedPresetConfig {
  defaults: {
    maxExtractionTokens: number;
    messageTokenBudget: number;
    minTokenGrowth: number;
  };
  preset: MemoryPreset;
}

export class BackgroundMemoryExtractor {
  private cachedState: string | undefined;
  private readonly config: BackgroundMemoryExtractorConfig;
  private readonly defaults: ResolvedPresetConfig["defaults"];
  private extractionInProgress = false;
  private readonly initialization: Promise<void>;
  private readonly preset: MemoryPreset;
  private tokensSinceLastExtraction = 0;
  private turnsSinceLastExtraction = 0;

  private hasExtractedAtLeastOnce = false;

  constructor(config: BackgroundMemoryExtractorConfig) {
    this.config = config;

    const resolved = resolvePresetConfig(config.preset);
    this.preset = resolved.preset;
    this.defaults = resolved.defaults;
    this.cachedState = undefined;
    this.initialization = this.initializeStore();
  }

  async onTurnComplete(
    messages: CheckpointMessage[],
    usage?: { inputTokens?: number; outputTokens?: number }
  ): Promise<void> {
    await this.initialization;

    this.turnsSinceLastExtraction += 1;
    this.tokensSinceLastExtraction += this.resolveUsageTokens(usage);

    if (!this.shouldExtract() || this.extractionInProgress) {
      return;
    }

    this.extractionInProgress = true;

    try {
      await this.extract(messages);
    } catch {
      this.resetCounters();
    } finally {
      this.extractionInProgress = false;
    }
  }

  getStructuredState(): string | undefined {
    if (!this.hasExtractedAtLeastOnce) {
      return undefined;
    }
    const content = this.cachedState?.trim();
    return content && content.length > 0 ? this.cachedState : undefined;
  }

  async getMemoryContent(): Promise<string> {
    await this.initialization;

    const content = await this.config.store.read();
    if (content.trim().length > 0) {
      this.cachedState = content;
      return content;
    }

    this.cachedState = this.preset.template;
    return this.preset.template;
  }

  private shouldExtract(): boolean {
    const thresholds = this.resolveThresholds();

    return (
      this.tokensSinceLastExtraction >= thresholds.minTokenGrowth &&
      this.turnsSinceLastExtraction >= thresholds.minTurns
    );
  }

  private async extract(messages: CheckpointMessage[]): Promise<void> {
    const existing = await this.config.store.read();
    const currentNotes =
      existing.trim().length > 0 ? existing : this.preset.template;
    const prompt = this.buildExtractionPrompt(currentNotes);

    const result = await generateText({
      model: this.config.model,
      messages: this.buildExtractionMessages(messages, prompt),
      maxOutputTokens: this.resolveMaxExtractionTokens(),
      temperature: 0,
    });

    const extracted = this.parseMemoryFromResponse(result.text);
    if (extracted) {
      await this.config.store.write(extracted);
      this.cachedState = extracted;
      this.hasExtractedAtLeastOnce = true;
    }

    this.resetCounters();
  }

  private buildExtractionMessages(
    messages: CheckpointMessage[],
    prompt: string
  ): ModelMessage[] {
    const baseMessages = messages.map((message) => message.message);
    const contextBudget = Math.max(
      0,
      this.defaults.messageTokenBudget - estimateTokens(prompt)
    );
    const recentMessages = selectRecentMessages(baseMessages, contextBudget);

    return [
      ...recentMessages,
      {
        role: "user",
        content: prompt,
      },
    ];
  }

  private buildExtractionPrompt(currentNotes: string): string {
    const escapedNotes = currentNotes.replace(
      CURRENT_NOTES_CLOSE_TAG_REGEX,
      "[/current_notes]"
    );

    return this.preset.extractionPrompt.replaceAll(
      "{{currentNotes}}",
      escapedNotes
    );
  }

  private parseMemoryFromResponse(text: string): string | undefined {
    const match = text.match(MEMORY_TAG_REGEX);
    const parsed = match ? match[1].trim() : text.trim();

    return parsed.length > 0 ? parsed : undefined;
  }

  private resolveMaxExtractionTokens(): number {
    return normalizePositiveInteger(
      this.config.maxExtractionTokens,
      this.defaults.maxExtractionTokens
    );
  }

  private resolveThresholds(): { minTokenGrowth: number; minTurns: number } {
    return {
      minTokenGrowth: normalizeNonNegativeInteger(
        this.config.thresholds?.minTokenGrowth,
        this.defaults.minTokenGrowth
      ),
      minTurns: normalizeNonNegativeInteger(
        this.config.thresholds?.minTurns,
        DEFAULT_MIN_TURNS
      ),
    };
  }

  private resolveUsageTokens(usage?: {
    inputTokens?: number;
    outputTokens?: number;
  }): number {
    const inputTokens = normalizeNonNegativeInteger(usage?.inputTokens, 0);
    const outputTokens = normalizeNonNegativeInteger(usage?.outputTokens, 0);
    return inputTokens + outputTokens;
  }

  private async initializeStore(): Promise<void> {
    if (await this.config.store.isEmpty()) {
      await this.config.store.write(this.preset.template);
      this.cachedState = this.preset.template;
      return;
    }

    const current = await this.config.store.read();
    if (current.trim().length === 0) {
      await this.config.store.write(this.preset.template);
      this.cachedState = this.preset.template;
      return;
    }

    this.cachedState = current;
  }

  private resetCounters(): void {
    this.tokensSinceLastExtraction = 0;
    this.turnsSinceLastExtraction = 0;
  }
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function selectRecentMessages(
  messages: ModelMessage[],
  maxTokens: number
): ModelMessage[] {
  if (messages.length === 0) {
    return [];
  }

  if (maxTokens <= 0) {
    return [messages.at(-1) as ModelMessage];
  }

  const result: ModelMessage[] = [];
  let totalTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageTokens = estimateMessageTokens(message);

    if (result.length > 0 && totalTokens + messageTokens > maxTokens) {
      break;
    }

    result.unshift(message);
    totalTokens += messageTokens;
  }

  return result.length > 0 ? result : [messages.at(-1) as ModelMessage];
}

function resolvePresetConfig(
  presetInput: BackgroundMemoryExtractorConfig["preset"]
): ResolvedPresetConfig {
  if (presetInput === "chat") {
    return {
      preset: CHAT_MEMORY_PRESET,
      defaults: {
        minTokenGrowth: CHAT_DEFAULT_MIN_TOKEN_GROWTH,
        maxExtractionTokens: CHAT_DEFAULT_MAX_EXTRACTION_TOKENS,
        messageTokenBudget: CHAT_MESSAGE_TOKEN_BUDGET,
      },
    };
  }

  if (presetInput === "code") {
    return {
      preset: CODE_MEMORY_PRESET,
      defaults: {
        minTokenGrowth: CODE_DEFAULT_MIN_TOKEN_GROWTH,
        maxExtractionTokens: CODE_DEFAULT_MAX_EXTRACTION_TOKENS,
        messageTokenBudget: CODE_MESSAGE_TOKEN_BUDGET,
      },
    };
  }

  return {
    preset: presetInput,
    defaults: {
      minTokenGrowth: CHAT_DEFAULT_MIN_TOKEN_GROWTH,
      maxExtractionTokens: CHAT_DEFAULT_MAX_EXTRACTION_TOKENS,
      messageTokenBudget: DEFAULT_MESSAGE_TOKEN_BUDGET,
    },
  };
}
