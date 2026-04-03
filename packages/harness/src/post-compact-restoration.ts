import type { CheckpointMessage } from "./compaction-types";
import { estimateTokens, extractMessageText } from "./token-utils";

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

  filterAgainstKeptMessages(keptMessages: CheckpointMessage[]): void {
    const keptLabels = new Set<string>();

    for (const checkpointMessage of keptMessages) {
      const text = extractMessageText(checkpointMessage.message);

      for (const label of this.items.keys()) {
        if (text.includes(label)) {
          keptLabels.add(label);
        }
      }
    }

    for (const label of keptLabels) {
      this.items.delete(label);
    }
  }

  getRestorationItems(): RestorationItem[] {
    const resolved = this.resolveConfig();
    const candidates = [...this.items.values()]
      .map((item) => truncateRestorationItem(item, resolved.maxItemTokens))
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

    const parts: string[] = [
      "[Restored context after compaction — files and skills from before compaction]",
      "",
    ];

    for (const item of items) {
      parts.push(`<restored-${item.type} label="${item.label}">`);
      parts.push(item.content);
      parts.push(`</restored-${item.type}>`);
      parts.push("");
    }

    return parts.join("\n");
  }

  buildRestorationMessages():
    | Array<{ content: string; role: "user" }>
    | undefined {
    const message = this.buildRestorationMessage();

    if (!message) {
      return undefined;
    }

    return [{ role: "user", content: message }];
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

function truncateRestorationItem(
  item: RestorationItem,
  maxItemTokens: number
): RestorationItem {
  if (item.tokens <= maxItemTokens) {
    return item;
  }

  const truncationNotice = "[... truncated]";
  const targetTokens = Math.max(0, Math.floor(maxItemTokens * 0.8));
  const truncatedBody = truncateToTokenLimit(item.content, targetTokens);
  const withNotice =
    truncatedBody.length > 0
      ? `${truncatedBody}\n${truncationNotice}`
      : truncationNotice;

  return {
    ...item,
    content: withNotice,
    tokens: estimateTokens(withNotice),
  };
}

function truncateToTokenLimit(text: string, tokenLimit: number): string {
  if (tokenLimit <= 0 || text.length === 0) {
    return "";
  }

  if (estimateTokens(text) <= tokenLimit) {
    return text;
  }

  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, mid);

    if (estimateTokens(candidate) <= tokenLimit) {
      low = mid;
      continue;
    }

    high = mid - 1;
  }

  return text.slice(0, low).trimEnd();
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}
