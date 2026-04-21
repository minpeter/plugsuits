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

  setMaxTotalTokens(tokens: number): void {
    this.config.maxTotalTokens = Math.max(0, tokens);
  }

  removeItem(label: string): void {
    this.items.delete(label);
  }

  filterAgainstKeptMessages(keptMessages: CheckpointMessage[]): void {
    const keptLabels = new Set<string>();

    for (const checkpointMessage of keptMessages) {
      const text = extractMessageText(checkpointMessage.message);

      for (const label of this.items.keys()) {
        if (textContainsLabel(text, label)) {
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
      return;
    }

    const parts: string[] = [
      "[Restored context after compaction — files and skills from before compaction]",
      "",
    ];

    for (const item of items) {
      const escapedLabel = escapeXmlAttribute(item.label);
      parts.push(`<restored-${item.type} label="${escapedLabel}">`);
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
      return;
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

function textContainsLabel(text: string, label: string): boolean {
  if (label.length === 0) {
    return false;
  }

  let startIndex = 0;
  while (true) {
    const pos = text.indexOf(label, startIndex);
    if (pos === -1) {
      return false;
    }

    const charBefore = pos > 0 ? text[pos - 1] : undefined;
    const afterPos = pos + label.length;
    const charAfter = afterPos < text.length ? text[afterPos] : undefined;

    const boundaryBefore =
      charBefore === undefined ||
      !isContinuationCharBefore(charBefore, text, pos - 1);
    const boundaryAfter =
      charAfter === undefined || !isContinuationChar(charAfter, text, afterPos);

    if (boundaryBefore && boundaryAfter) {
      return true;
    }

    startIndex = pos + 1;
  }
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const WORD_CHAR_RE = /\w/;

function isContinuationChar(
  ch: string,
  text: string,
  charPos: number
): boolean {
  if (WORD_CHAR_RE.test(ch)) {
    return true;
  }
  if (ch === "." || ch === "-") {
    const next = charPos + 1 < text.length ? text[charPos + 1] : undefined;
    return next !== undefined && WORD_CHAR_RE.test(next);
  }
  return false;
}

function isContinuationCharBefore(
  ch: string,
  text: string,
  charPos: number
): boolean {
  if (WORD_CHAR_RE.test(ch)) {
    return true;
  }
  if (ch === "." || ch === "-") {
    const prev = charPos - 1 >= 0 ? text[charPos - 1] : undefined;
    return prev !== undefined && WORD_CHAR_RE.test(prev);
  }
  return false;
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}
