import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { CheckpointMessage } from "./compaction-types";
import {
  CHAT_MEMORY_PRESET,
  CODE_MEMORY_PRESET,
  type MemoryPreset,
} from "./memory-presets";
import type { MemoryStore } from "./memory-store";
import {
  estimateMessageTokens,
  estimateTokens,
  extractMessageText,
} from "./token-utils";

export interface BackgroundMemoryExtractorConfig {
  incremental?: boolean;
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
const UPDATE_TAG_REGEX =
  /<update\s+section\s*=\s*(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/update>/gi;
const CURRENT_NOTES_CLOSE_TAG_REGEX = /<\/current_notes>/gi;
const RECENT_CONVERSATION_CLOSE_TAG_REGEX = /<\/recent_conversation>/gi;
const MEMORY_SECTION_HEADING_REGEX = /^#\s+(.+?)\s*$/gm;
const SECTION_NAME_WHITESPACE_REGEX = /\s+/g;

interface SectionUpdate {
  content: string;
  section: string;
}

interface MemorySectionRange {
  contentEnd: number;
  contentStart: number;
  name: string;
}

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
  private readonly incremental: boolean;
  private readonly initialization: Promise<void>;
  private lastExtractionMessageIndex = 0;
  private readonly preset: MemoryPreset;
  private tokensSinceLastExtraction = 0;
  private turnsSinceLastExtraction = 0;

  private hasExtractedAtLeastOnce = false;

  constructor(config: BackgroundMemoryExtractorConfig) {
    this.config = config;

    const resolved = resolvePresetConfig(config.preset);
    this.preset = resolved.preset;
    this.defaults = resolved.defaults;
    this.incremental = config.incremental ?? true;
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
    const baseMessages = messages.map((message) => message.message);
    const extractionMessages = this.incremental
      ? this.buildIncrementalExtractionMessages(baseMessages, currentNotes)
      : this.buildExtractionMessages(
          baseMessages,
          this.buildExtractionPrompt(currentNotes)
        );

    const result = await generateText({
      model: this.config.model,
      messages: extractionMessages,
      maxOutputTokens: this.resolveMaxExtractionTokens(),
      temperature: 0,
    });

    const extracted = this.resolveExtractedMemory(result.text, currentNotes);
    if (extracted) {
      await this.config.store.write(extracted);
      this.cachedState = extracted;
      this.hasExtractedAtLeastOnce = true;
      this.lastExtractionMessageIndex = messages.length;
    }

    this.resetCounters();
  }

  private buildExtractionMessages(
    messages: ModelMessage[],
    prompt: string
  ): ModelMessage[] {
    const contextBudget = Math.max(
      0,
      this.defaults.messageTokenBudget - estimateTokens(prompt)
    );
    const recentMessages = selectRecentMessages(messages, contextBudget);

    return [
      ...recentMessages,
      {
        role: "user",
        content: prompt,
      },
    ];
  }

  private buildIncrementalExtractionMessages(
    messages: ModelMessage[],
    currentNotes: string
  ): ModelMessage[] {
    const messagesSinceLastExtraction = selectMessagesSinceLastExtraction(
      messages,
      this.lastExtractionMessageIndex
    );
    const prompt = this.buildIncrementalExtractionPrompt(
      currentNotes,
      messagesSinceLastExtraction
    );

    return [
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

  private buildIncrementalExtractionPrompt(
    currentNotes: string,
    recentMessages: ModelMessage[]
  ): string {
    const escapedNotes = currentNotes.replace(
      CURRENT_NOTES_CLOSE_TAG_REGEX,
      "[/current_notes]"
    );

    const promptTemplate = [
      "You are a memory extraction agent. Update session notes incrementally from recent conversation only.",
      "",
      "Current session notes:",
      "<current_notes>",
      escapedNotes,
      "</current_notes>",
      "",
      "Recent conversation (since last update):",
      "<recent_conversation>",
      "{{recentConversation}}",
      "</recent_conversation>",
      "",
      "Update ONLY the sections that have changed.",
      "For each section you update, wrap it exactly as:",
      '<update section="Section Name">new content</update>',
      "",
      "RULES:",
      "- Do NOT include unchanged sections.",
      "- The section name must match an existing '# Section Name' heading.",
      "- Output only <update ...> blocks.",
      "",
      "Backward compatibility: if you cannot produce targeted updates, return the complete document in <memory>...</memory> tags.",
    ].join("\n");

    const promptWithoutConversation = promptTemplate.replace(
      "{{recentConversation}}",
      ""
    );
    const conversationBudget = Math.max(
      0,
      this.defaults.messageTokenBudget -
        estimateTokens(promptWithoutConversation)
    );
    const limitedRecentMessages = selectRecentMessages(
      recentMessages,
      conversationBudget
    );
    const renderedRecentConversation = renderConversationForPrompt(
      limitedRecentMessages
    ).replace(RECENT_CONVERSATION_CLOSE_TAG_REGEX, "[/recent_conversation]");

    return promptTemplate.replace(
      "{{recentConversation}}",
      renderedRecentConversation
    );
  }

  private resolveExtractedMemory(
    text: string,
    currentNotes: string
  ): string | undefined {
    if (this.incremental) {
      const updates = this.parseSectionUpdates(text);
      if (updates.length > 0) {
        const merged = mergeSectionUpdates(currentNotes, updates);
        return merged.trim().length > 0 ? merged : undefined;
      }
    }

    return this.parseMemoryFromResponse(text);
  }

  private parseSectionUpdates(text: string): SectionUpdate[] {
    const updates: SectionUpdate[] = [];
    const updateTagRegex = new RegExp(
      UPDATE_TAG_REGEX.source,
      UPDATE_TAG_REGEX.flags
    );

    for (const match of text.matchAll(updateTagRegex)) {
      const section = (match[1] ?? match[2] ?? "").trim();
      if (section.length === 0) {
        continue;
      }

      updates.push({
        section,
        content: match[3].trim(),
      });
    }

    return updates;
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

function selectMessagesSinceLastExtraction(
  messages: ModelMessage[],
  lastExtractionMessageIndex: number
): ModelMessage[] {
  if (messages.length === 0) {
    return [];
  }

  const normalizedIndex = normalizeNonNegativeInteger(
    lastExtractionMessageIndex,
    0
  );
  const startIndex = normalizedIndex <= messages.length ? normalizedIndex : 0;

  return messages.slice(startIndex);
}

function renderConversationForPrompt(messages: ModelMessage[]): string {
  if (messages.length === 0) {
    return "(No new conversation since last update.)";
  }

  return messages
    .map((message, index) => {
      const text = extractMessageText(message).trim();
      const content = text.length > 0 ? text : "(no textual content)";
      return `[${index + 1}] ${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n");
}

function mergeSectionUpdates(
  currentNotes: string,
  updates: SectionUpdate[]
): string {
  const sections = parseMemorySections(currentNotes);
  if (sections.length === 0) {
    return currentNotes;
  }

  const updatesBySection = new Map<string, string>();
  for (const update of updates) {
    updatesBySection.set(
      normalizeSectionName(update.section),
      update.content.trim()
    );
  }

  let merged = currentNotes;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    const updateContent = updatesBySection.get(
      normalizeSectionName(section.name)
    );

    if (updateContent === undefined) {
      continue;
    }

    const hasNextSection = index < sections.length - 1;
    const replacement = formatSectionContent(updateContent, hasNextSection);
    merged =
      merged.slice(0, section.contentStart) +
      replacement +
      merged.slice(section.contentEnd);
  }

  return merged;
}

function parseMemorySections(content: string): MemorySectionRange[] {
  const sectionHeadingRegex = new RegExp(
    MEMORY_SECTION_HEADING_REGEX.source,
    MEMORY_SECTION_HEADING_REGEX.flags
  );
  const matches = Array.from(content.matchAll(sectionHeadingRegex));

  return matches.map((match, index) => {
    const headingIndex = match.index ?? 0;
    const headingEnd = headingIndex + match[0].length;
    const contentStart = skipSingleLineBreak(content, headingEnd);
    const nextHeadingIndex = matches[index + 1]?.index ?? content.length;

    return {
      name: match[1].trim(),
      contentStart,
      contentEnd: nextHeadingIndex,
    };
  });
}

function skipSingleLineBreak(text: string, index: number): number {
  if (text.startsWith("\r\n", index)) {
    return index + 2;
  }

  if (text[index] === "\n") {
    return index + 1;
  }

  return index;
}

function formatSectionContent(
  content: string,
  hasNextSection: boolean
): string {
  const trimmed = content.trim();

  if (!hasNextSection) {
    return trimmed;
  }

  return trimmed.length > 0 ? `${trimmed}\n\n` : "\n\n";
}

function normalizeSectionName(sectionName: string): string {
  return sectionName
    .trim()
    .replace(SECTION_NAME_WHITESPACE_REGEX, " ")
    .toLowerCase();
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
