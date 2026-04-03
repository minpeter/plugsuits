import { estimateTokens } from "./token-utils";

export interface RestorationItem {
  content: string;
  label: string;
  priority: number;
  tokens: number;
  type: "file" | "skill" | "context";
}

export interface PostCompactRestorationConfig {
  maxItems?: number;
  maxItemTokens?: number;
  maxTotalTokens?: number;
}

interface ResolvedRestorationConfig {
  maxItems: number;
  maxItemTokens: number;
  maxTotalTokens: number;
}

const DEFAULT_MAX_TOTAL_TOKENS = 50_000;
const DEFAULT_MAX_ITEM_TOKENS = 5000;
const DEFAULT_MAX_ITEMS = 10;

export class PostCompactRestorer {
  private readonly config: PostCompactRestorationConfig;
  private readonly items = new Map<string, RestorationItem>();

  constructor(config: PostCompactRestorationConfig = {}) {
    this.config = config;
  }

  trackItem(item: Omit<RestorationItem, "tokens"> & { content: string }): void {
    this.items.set(item.label, {
      ...item,
      tokens: estimateTokens(item.content),
    });

    this.enforceMaxItems();
  }

  removeItem(label: string): void {
    this.items.delete(label);
  }

  getRestorationItems(): RestorationItem[] {
    const resolved = this.resolveConfig();
    const candidates = [...this.items.values()]
      .filter((item) => item.tokens <= resolved.maxItemTokens)
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }

        if (a.tokens !== b.tokens) {
          return a.tokens - b.tokens;
        }

        return a.label.localeCompare(b.label);
      });

    const selected: RestorationItem[] = [];
    let totalTokens = 0;

    for (const item of candidates) {
      if (totalTokens + item.tokens > resolved.maxTotalTokens) {
        continue;
      }

      selected.push(item);
      totalTokens += item.tokens;
    }

    return selected;
  }

  buildRestorationMessage(): string | undefined {
    const items = this.getRestorationItems();

    if (items.length === 0) {
      return undefined;
    }

    const sections = items.map(
      (item) => `### ${item.type}: ${item.label}\n${item.content}`
    );

    return [
      "[Restored Context — recently accessed files and skills]",
      ...sections,
    ].join("\n\n");
  }

  clear(): void {
    this.items.clear();
  }

  private enforceMaxItems(): void {
    const { maxItems } = this.resolveConfig();

    while (this.items.size > maxItems) {
      const lowestPriorityLabel = this.getLowestPriorityLabel();
      if (!lowestPriorityLabel) {
        break;
      }

      this.items.delete(lowestPriorityLabel);
    }
  }

  private getLowestPriorityLabel(): string | undefined {
    let lowest: RestorationItem | undefined;

    for (const item of this.items.values()) {
      if (!lowest || item.priority < lowest.priority) {
        lowest = item;
      }
    }

    return lowest?.label;
  }

  private resolveConfig(): ResolvedRestorationConfig {
    return {
      maxTotalTokens: normalizeNonNegativeInteger(
        this.config.maxTotalTokens,
        DEFAULT_MAX_TOTAL_TOKENS
      ),
      maxItemTokens: normalizeNonNegativeInteger(
        this.config.maxItemTokens,
        DEFAULT_MAX_ITEM_TOKENS
      ),
      maxItems: normalizeNonNegativeInteger(
        this.config.maxItems,
        DEFAULT_MAX_ITEMS
      ),
    };
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
