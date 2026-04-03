import { estimateTokens } from "./token-utils";

export interface SessionMemoryConfig {
  categories?: string[];
  maxFacts?: number;
  maxStateTokens?: number;
}

export interface MemoryFact {
  category: string;
  key: string;
  updatedAt: number;
  value: string;
}

const DEFAULT_MAX_FACTS = 50;
const DEFAULT_MAX_STATE_TOKENS = 500;
const DEFAULT_CATEGORIES = [
  "identity",
  "preferences",
  "relationships",
  "context",
];

const OTHER_CATEGORY = "other";
const CONTEXT_CATEGORY = "context";

const USER_PROFILE_HEADING_REGEX = /^\s*##\s*(?:\d+\.\s*)?User Profile\b/i;
const SECTION_HEADING_REGEX = /^\s*##\s+/;
const BOLD_BULLET_FACT_REGEX = /^\s*-\s+\*\*(.+?)\*\*:\s*(.+?)\s*$/;
const BULLET_FACT_REGEX = /^\s*-\s+([^:]+):\s*(.+?)\s*$/;
const CATEGORY_SPLIT_REGEX = /[\s_-]+/;
const LINE_SPLIT_REGEX = /\r?\n/;
const SENTENCE_SPLIT_REGEX = /[.!?\n]+/;
const ROLE_FILTER_REGEX =
  /^(?:\d+|very|really|so|not|also|still|just|now|here|there)$/i;
const KEY_FILTER_REGEX =
  /^(?:name|job|goal|plan|idea|question|answer|problem|issue|point|take|guess)$/i;

const USER_MSG_PATTERNS: Array<{
  pattern: RegExp;
  extract: (match: RegExpMatchArray) => { key: string; value: string } | null;
}> = [
  {
    pattern: /\bmy name is\s+([A-Z][a-z]+)\b/i,
    extract: (m) => ({ key: "name", value: m[1] }),
  },
  {
    pattern:
      /\bI(?:'m| am)\s+([A-Z][a-z]+)\b(?!\s+(?:going|trying|looking|thinking|working|using|learning|planning|turning))/,
    extract: (m) => ({ key: "name", value: m[1] }),
  },
  {
    pattern:
      /\bI (?:have|got|adopted|just adopted) (?:a |an )?([\w\s]+?)\s+(?:named?|called)\s+(\w+)/i,
    extract: (m) => ({
      key: `pet ${m[2].toLowerCase()}`,
      value: `${m[2]} (${m[1].trim()})`,
    }),
  },
  {
    pattern: /\bI (?:work|am working) (?:at|for)\s+(.+?)(?:\s+as\s+(.+))?$/i,
    extract: (m) =>
      m[2]
        ? { key: "job", value: `${m[2].trim()} at ${m[1].trim()}` }
        : { key: "workplace", value: m[1].trim() },
  },
  {
    pattern: /\bI (?:work|am working) as (?:a |an )?(.+?)(?:\s+at\s+(.+))?$/i,
    extract: (m) =>
      m[2]
        ? { key: "job", value: `${m[1].trim()} at ${m[2].trim()}` }
        : { key: "job", value: m[1].trim() },
  },
  {
    pattern: /\bI(?:'m| am) (?:a |an )([\w\s]+?)(?:\s+(?:at|in|for)\s+(.+))?$/i,
    extract: (m) => {
      const role = m[1].trim();
      if (ROLE_FILTER_REGEX.test(role)) {
        return null;
      }
      return m[2]
        ? { key: "job", value: `${role} at ${m[2].trim()}` }
        : { key: "job", value: role };
    },
  },
  {
    pattern: /\bI live in\s+(.+)/i,
    extract: (m) => ({ key: "location", value: m[1].trim() }),
  },
  {
    pattern: /\bI(?:'m| am) (?:from|in|based in)\s+([A-Z][\w\s,]+)/i,
    extract: (m) => ({ key: "location", value: m[1].trim() }),
  },
  {
    pattern: /\bmy (?:favorite|favourite)\s+([\w\s]+?)\s+is\s+(.+)/i,
    extract: (m) => ({ key: `favorite ${m[1].trim()}`, value: m[2].trim() }),
  },
  {
    pattern:
      /\bI (?:love|really like|enjoy)\s+(?:cooking\s+)?(\w[\w\s]*?)(?:\s+food)?$/i,
    extract: (m) => ({ key: "interest", value: m[1].trim() }),
  },
  {
    pattern: /\bI (?:love|really like|enjoy)\s+(\w[\w\s]+)/i,
    extract: (m) => ({ key: "interest", value: m[1].trim() }),
  },
  {
    pattern: /\bmy (\w+(?:'s)?)\s+(?:name is|is named|called)\s+(\w+)/i,
    extract: (m) => ({
      key: m[1].toLowerCase().replace("'s", ""),
      value: m[2],
    }),
  },
  {
    pattern: /\bmy (\w+)\s+is\s+([A-Z][\w]+(?:\s+[A-Z][\w]+)?)\b/,
    extract: (m) => {
      const key = m[1].toLowerCase();
      if (KEY_FILTER_REGEX.test(key)) {
        return null;
      }
      return { key, value: m[2] };
    },
  },
  {
    pattern:
      /\bmy\s+(sister|brother|partner|wife|husband|friend|mother|father|daughter|son)\s+([A-Z]\w+)/i,
    extract: (m) => ({ key: m[1].toLowerCase(), value: m[2] }),
  },
  {
    pattern: /\bI(?:'m| am)\s+(\d+)\s+years?\s+old/i,
    extract: (m) => ({ key: "age", value: m[1] }),
  },
  {
    pattern: /\bI(?:'m| am) turning\s+(\d+)/i,
    extract: (m) => ({ key: "age", value: m[1] }),
  },
  {
    pattern: /\bmy birthday is\s+(.+)/i,
    extract: (m) => ({ key: "birthday", value: m[1].trim() }),
  },
  {
    pattern: /\bI grew up in\s+(.+)/i,
    extract: (m) => ({ key: "hometown", value: m[1].trim() }),
  },
];

function extractFactsFromSentence(
  sentence: string
): Array<{ key: string; value: string }> {
  const results: Array<{ key: string; value: string }> = [];

  for (const { pattern, extract } of USER_MSG_PATTERNS) {
    const match = sentence.match(pattern);
    if (!match) {
      continue;
    }

    const fact = extract(match);
    if (fact?.key && fact.value) {
      results.push(fact);
    }
  }

  return results;
}

const IDENTITY_KEYWORDS = [
  "name",
  "age",
  "job",
  "occupation",
  "profession",
  "title",
  "company",
  "location",
  "city",
  "country",
  "language",
];

const PREFERENCE_KEYWORDS = [
  "food",
  "color",
  "book",
  "movie",
  "music",
  "hobby",
  "drink",
  "cuisine",
  "genre",
];

const RELATIONSHIP_KEYWORDS = [
  "sister",
  "brother",
  "partner",
  "spouse",
  "wife",
  "husband",
  "friend",
  "mother",
  "father",
  "parent",
  "daughter",
  "son",
  "mentor",
  "colleague",
  "dog",
  "cat",
  "pet",
  "retriever",
  "puppy",
  "kitten",
];

const CONTEXT_KEYWORDS = [
  "goal",
  "task",
  "project",
  "deadline",
  "schedule",
  "timezone",
  "plan",
  "status",
];

function normalizeCategoryName(category: string): string {
  return category.trim().toLowerCase();
}

function normalizeFactKey(key: string): string {
  return key.trim().toLowerCase();
}

function toTitleCase(input: string): string {
  return input
    .split(CATEGORY_SPLIT_REGEX)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function matchesKeyword(key: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => key === keyword || key.includes(keyword));
}

export class SessionMemoryTracker {
  private readonly categories: string[];
  private readonly categorySet: Set<string>;
  private readonly factsByCategory = new Map<string, Map<string, MemoryFact>>();
  private readonly maxFacts: number;
  private readonly maxStateTokens: number;

  constructor(config: SessionMemoryConfig = {}) {
    this.categories = this.normalizeConfiguredCategories(config.categories);
    this.categorySet = new Set(this.categories);
    this.maxFacts = Math.max(0, config.maxFacts ?? DEFAULT_MAX_FACTS);
    this.maxStateTokens = Math.max(
      0,
      config.maxStateTokens ?? DEFAULT_MAX_STATE_TOKENS
    );
  }

  setFact(category: string, key: string, value: string): void {
    const normalizedCategory = this.normalizeCategory(category);
    const normalizedKey = normalizeFactKey(key);

    if (!normalizedKey) {
      return;
    }

    this.setFactInternal(
      normalizedCategory,
      normalizedKey,
      value.trim(),
      Date.now()
    );
    this.evictOldFacts();
  }

  getFact(category: string, key: string): string | undefined {
    const normalizedCategory = this.normalizeCategory(category);
    const normalizedKey = normalizeFactKey(key);
    const categoryFacts = this.factsByCategory.get(normalizedCategory);
    return categoryFacts?.get(normalizedKey)?.value;
  }

  getCategory(category: string): MemoryFact[] {
    const normalizedCategory = this.normalizeCategory(category);
    const categoryFacts = this.factsByCategory.get(normalizedCategory);

    if (!categoryFacts) {
      return [];
    }

    return Array.from(categoryFacts.values())
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((fact) => ({ ...fact }));
  }

  getAllFacts(): MemoryFact[] {
    const facts: MemoryFact[] = [];

    for (const categoryFacts of this.factsByCategory.values()) {
      for (const fact of categoryFacts.values()) {
        facts.push({ ...fact });
      }
    }

    return facts.sort((a, b) => {
      if (a.category !== b.category) {
        return a.category.localeCompare(b.category);
      }
      return a.key.localeCompare(b.key);
    });
  }

  removeFact(category: string, key: string): boolean {
    const normalizedCategory = this.normalizeCategory(category);
    const normalizedKey = normalizeFactKey(key);
    const categoryFacts = this.factsByCategory.get(normalizedCategory);

    if (!categoryFacts) {
      return false;
    }

    const deleted = categoryFacts.delete(normalizedKey);

    if (categoryFacts.size === 0) {
      this.factsByCategory.delete(normalizedCategory);
    }

    return deleted;
  }

  clear(): void {
    this.factsByCategory.clear();
  }

  getStructuredState(): string | undefined {
    const orderedFacts = this.getOrderedFactsForStructuredState();

    if (orderedFacts.length === 0) {
      return undefined;
    }

    for (
      let includeCount = orderedFacts.length;
      includeCount >= 1;
      includeCount--
    ) {
      const structuredState = this.renderStructuredState(
        orderedFacts,
        includeCount
      );

      if (estimateTokens(structuredState) <= this.maxStateTokens) {
        return structuredState;
      }
    }

    const headerOnly = "## Session Memory";
    return estimateTokens(headerOnly) <= this.maxStateTokens
      ? headerOnly
      : undefined;
  }

  extractFactsFromUserMessage(text: string): number {
    let extracted = 0;
    const sentences = text
      .split(SENTENCE_SPLIT_REGEX)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const sentence of sentences) {
      const facts = extractFactsFromSentence(sentence);
      for (const fact of facts) {
        const category = this.inferCategoryFromKey(fact.key);
        this.setFact(category, fact.key, fact.value);
        extracted++;
      }
    }

    return extracted;
  }

  extractFactsFromSummary(summary: string): void {
    const lines = summary.split(LINE_SPLIT_REGEX);
    const profileStart = lines.findIndex((line) =>
      USER_PROFILE_HEADING_REGEX.test(line)
    );

    if (profileStart < 0) {
      return;
    }

    for (let index = profileStart + 1; index < lines.length; index++) {
      const line = lines[index];

      if (SECTION_HEADING_REGEX.test(line)) {
        break;
      }

      const parsedFact = this.parseFactLine(line);
      if (!parsedFact) {
        continue;
      }

      const inferredCategory = this.inferCategoryFromKey(parsedFact.key);
      this.setFact(inferredCategory, parsedFact.key, parsedFact.value);
    }
  }

  get size(): number {
    let total = 0;
    for (const facts of this.factsByCategory.values()) {
      total += facts.size;
    }
    return total;
  }

  toJSON(): Record<string, MemoryFact[]> {
    const output: Record<string, MemoryFact[]> = {};

    for (const [category, facts] of this.factsByCategory.entries()) {
      output[category] = Array.from(facts.values())
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((fact) => ({ ...fact }));
    }

    return output;
  }

  fromJSON(data: Record<string, MemoryFact[]>): void {
    this.clear();

    for (const [categoryKey, rawFacts] of Object.entries(data)) {
      if (!Array.isArray(rawFacts)) {
        continue;
      }

      for (const rawFact of rawFacts) {
        const normalizedFact = this.normalizeImportedFact(rawFact, categoryKey);
        if (!normalizedFact) {
          continue;
        }

        this.setFactInternal(
          normalizedFact.category,
          normalizedFact.key,
          normalizedFact.value,
          normalizedFact.updatedAt
        );
      }
    }

    this.evictOldFacts();
  }

  private normalizeConfiguredCategories(categories?: string[]): string[] {
    const source =
      categories && categories.length > 0 ? categories : DEFAULT_CATEGORIES;
    const normalized: string[] = [];
    const seen = new Set<string>();

    for (const category of source) {
      const normalizedCategory = normalizeCategoryName(category);
      if (!normalizedCategory || seen.has(normalizedCategory)) {
        continue;
      }

      seen.add(normalizedCategory);
      normalized.push(normalizedCategory);
    }

    if (normalized.length === 0) {
      return [...DEFAULT_CATEGORIES];
    }

    return normalized;
  }

  private normalizeCategory(category: string): string {
    const normalizedCategory = normalizeCategoryName(category);

    if (!normalizedCategory) {
      return OTHER_CATEGORY;
    }

    return this.categorySet.has(normalizedCategory)
      ? normalizedCategory
      : OTHER_CATEGORY;
  }

  private inferCategoryFromKey(key: string): string {
    const normalizedKey = normalizeFactKey(key);

    if (matchesKeyword(normalizedKey, RELATIONSHIP_KEYWORDS)) {
      return "relationships";
    }

    if (matchesKeyword(normalizedKey, PREFERENCE_KEYWORDS)) {
      return "preferences";
    }

    if (matchesKeyword(normalizedKey, IDENTITY_KEYWORDS)) {
      return "identity";
    }

    if (matchesKeyword(normalizedKey, CONTEXT_KEYWORDS)) {
      return CONTEXT_CATEGORY;
    }

    return this.categorySet.has(CONTEXT_CATEGORY)
      ? CONTEXT_CATEGORY
      : OTHER_CATEGORY;
  }

  private parseFactLine(
    line: string
  ): { key: string; value: string } | undefined {
    const boldMatch = line.match(BOLD_BULLET_FACT_REGEX);
    if (boldMatch) {
      const [, rawKey, rawValue] = boldMatch;
      const key = rawKey.trim();
      const value = rawValue.trim();
      if (!(key && value)) {
        return undefined;
      }
      return { key, value };
    }

    const plainMatch = line.match(BULLET_FACT_REGEX);
    if (!plainMatch) {
      return undefined;
    }

    const [, rawKey, rawValue] = plainMatch;
    const key = rawKey.trim();
    const value = rawValue.trim();

    if (!(key && value)) {
      return undefined;
    }

    return { key, value };
  }

  private normalizeImportedFact(
    rawFact: MemoryFact,
    categoryKey: string
  ): MemoryFact | undefined {
    const rawCategory =
      typeof rawFact.category === "string" ? rawFact.category : categoryKey;
    const rawKey = typeof rawFact.key === "string" ? rawFact.key : "";
    const rawValue = typeof rawFact.value === "string" ? rawFact.value : "";
    const rawUpdatedAt =
      typeof rawFact.updatedAt === "number" &&
      Number.isFinite(rawFact.updatedAt)
        ? rawFact.updatedAt
        : Date.now();

    const normalizedCategory = this.normalizeCategory(rawCategory);
    const normalizedKey = normalizeFactKey(rawKey);

    if (!normalizedKey) {
      return undefined;
    }

    return {
      category: normalizedCategory,
      key: normalizedKey,
      value: rawValue.trim(),
      updatedAt: rawUpdatedAt,
    };
  }

  private setFactInternal(
    category: string,
    key: string,
    value: string,
    updatedAt: number
  ): void {
    let categoryFacts = this.factsByCategory.get(category);

    if (!categoryFacts) {
      categoryFacts = new Map<string, MemoryFact>();
      this.factsByCategory.set(category, categoryFacts);
    }

    const existing = categoryFacts.get(key);
    if (existing && existing.updatedAt > updatedAt) {
      return;
    }

    categoryFacts.set(key, {
      category,
      key,
      value,
      updatedAt,
    });
  }

  private evictOldFacts(): void {
    if (this.maxFacts <= 0) {
      this.clear();
      return;
    }

    while (this.size > this.maxFacts) {
      const oldest = this.findOldestFact();

      if (!oldest) {
        break;
      }

      const categoryFacts = this.factsByCategory.get(oldest.category);
      if (!categoryFacts) {
        break;
      }

      categoryFacts.delete(oldest.key);
      if (categoryFacts.size === 0) {
        this.factsByCategory.delete(oldest.category);
      }
    }
  }

  private findOldestFact(): MemoryFact | undefined {
    let oldest: MemoryFact | undefined;

    for (const categoryFacts of this.factsByCategory.values()) {
      for (const fact of categoryFacts.values()) {
        if (!oldest || fact.updatedAt < oldest.updatedAt) {
          oldest = fact;
          continue;
        }

        if (
          oldest &&
          fact.updatedAt === oldest.updatedAt &&
          `${fact.category}:${fact.key}` < `${oldest.category}:${oldest.key}`
        ) {
          oldest = fact;
        }
      }
    }

    return oldest;
  }

  private getStructuredCategoryOrder(): string[] {
    const presentCategories = Array.from(this.factsByCategory.keys());
    const ordered: string[] = [];

    for (const category of this.categories) {
      if (this.factsByCategory.has(category)) {
        ordered.push(category);
      }
    }

    if (
      this.factsByCategory.has(OTHER_CATEGORY) &&
      !ordered.includes(OTHER_CATEGORY)
    ) {
      ordered.push(OTHER_CATEGORY);
    }

    const additionalCategories = presentCategories
      .filter((category) => !ordered.includes(category))
      .sort((a, b) => a.localeCompare(b));

    ordered.push(...additionalCategories);
    return ordered;
  }

  private getOrderedFactsForStructuredState(): MemoryFact[] {
    const facts: MemoryFact[] = [];
    const categories = this.getStructuredCategoryOrder();

    for (const category of categories) {
      const categoryFacts = this.factsByCategory.get(category);
      if (!categoryFacts) {
        continue;
      }

      const sortedFacts = Array.from(categoryFacts.values()).sort((a, b) =>
        a.key.localeCompare(b.key)
      );
      facts.push(...sortedFacts);
    }

    return facts;
  }

  private renderStructuredState(
    allFacts: MemoryFact[],
    includeCount: number
  ): string {
    const selectedFacts = allFacts.slice(0, includeCount);
    const grouped = new Map<string, MemoryFact[]>();

    for (const fact of selectedFacts) {
      const facts = grouped.get(fact.category);
      if (facts) {
        facts.push(fact);
      } else {
        grouped.set(fact.category, [fact]);
      }
    }

    const lines: string[] = ["## Session Memory"];

    for (const category of this.getStructuredCategoryOrder()) {
      const facts = grouped.get(category);
      if (!facts || facts.length === 0) {
        continue;
      }

      lines.push(`### ${toTitleCase(category)}`);

      for (const fact of facts) {
        lines.push(`- ${fact.key}: ${fact.value}`);
      }
    }

    return lines.join("\n");
  }
}
