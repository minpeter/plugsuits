import type { ContextBudget } from "./compaction-policy";
import { getContextPressureLevel } from "./compaction-policy";
import type { ContextTokenStats } from "./context-analysis";

const TOOL_RESULTS_WARNING_RATIO = 0.2;
const LARGE_TOOL_RESULT_TOKENS = 5000;
const MAX_DUPLICATE_SUGGESTIONS = 3;

const LEVEL_PRIORITY: Record<ContextSuggestion["level"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export interface ContextSuggestion {
  estimatedSavings?: number;
  level: "info" | "warning" | "error";
  message: string;
}

function getUsagePercent(currentTokens: number, hardLimitAt: number): number {
  const safeLimit = Math.max(1, hardLimitAt);
  return Math.round((currentTokens / safeLimit) * 100);
}

function getTotalToolResultTokens(stats: ContextTokenStats): number {
  return [...stats.toolResults.values()].reduce((sum, item) => {
    return sum + item.tokens;
  }, 0);
}

function getLargestSingleToolResult(stats: ContextTokenStats): {
  kind: "aggregate" | "message";
  label: string;
  tokens: number;
} | null {
  const aggregateMatch = [...stats.toolResults.entries()]
    .filter(
      ([, value]) =>
        value.count === 1 && value.tokens > LARGE_TOOL_RESULT_TOKENS
    )
    .sort((a, b) => b[1].tokens - a[1].tokens)[0];

  if (aggregateMatch) {
    return {
      kind: "aggregate",
      label: aggregateMatch[0],
      tokens: aggregateMatch[1].tokens,
    };
  }

  const messageMatch = [...stats.largestMessages]
    .filter(
      (item) => item.role === "tool" && item.tokens > LARGE_TOOL_RESULT_TOKENS
    )
    .sort((a, b) => b.tokens - a.tokens)[0];

  if (!messageMatch) {
    return null;
  }

  return {
    kind: "message",
    label: `message #${messageMatch.index}`,
    tokens: messageMatch.tokens,
  };
}

function getDuplicateReadSuggestions(
  stats: ContextTokenStats
): ContextSuggestion[] {
  return [...stats.duplicateReads.entries()]
    .sort((a, b) => b[1].wastedTokens - a[1].wastedTokens)
    .slice(0, MAX_DUPLICATE_SUGGESTIONS)
    .map(([path, duplicate]) => {
      return {
        level:
          duplicate.wastedTokens >= LARGE_TOOL_RESULT_TOKENS
            ? "warning"
            : "info",
        message: `File ${path} read ${duplicate.count} times, ~${duplicate.wastedTokens} tokens wasted.`,
        estimatedSavings: duplicate.wastedTokens,
      };
    });
}

function sortSuggestions(
  suggestions: ContextSuggestion[]
): ContextSuggestion[] {
  return suggestions.sort((a, b) => {
    const byLevel = LEVEL_PRIORITY[a.level] - LEVEL_PRIORITY[b.level];
    if (byLevel !== 0) {
      return byLevel;
    }
    return (b.estimatedSavings ?? 0) - (a.estimatedSavings ?? 0);
  });
}

export function generateContextSuggestions(
  stats: ContextTokenStats,
  budget: ContextBudget,
  currentTokens: number
): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = [];
  const pressure = getContextPressureLevel(currentTokens, budget);
  const usagePercent = getUsagePercent(currentTokens, budget.hardLimitAt);

  if (budget.hardLimitAt <= budget.warningAt && pressure === "critical") {
    suggestions.push({
      level: "error",
      message: `Context is ${usagePercent}% full and at the hard limit.`,
    });
  } else if (currentTokens >= budget.warningAt) {
    suggestions.push({
      level: pressure === "critical" ? "error" : "warning",
      message:
        pressure === "critical"
          ? `Context is ${usagePercent}% full and at the hard limit.`
          : `Context is ${usagePercent}% full.`,
    });
  }

  const totalToolResultTokens = getTotalToolResultTokens(stats);
  const toolResultRatio =
    stats.total > 0 ? totalToolResultTokens / stats.total : 0;

  if (toolResultRatio > TOOL_RESULTS_WARNING_RATIO) {
    suggestions.push({
      level: "warning",
      message: `Tool results: ${Math.round(toolResultRatio * 100)}% of context — use narrower queries`,
      estimatedSavings: Math.floor(totalToolResultTokens * 0.25),
    });
  }

  suggestions.push(...getDuplicateReadSuggestions(stats));

  const largeToolResult = getLargestSingleToolResult(stats);
  if (largeToolResult) {
    suggestions.push({
      level: "warning",
      message:
        largeToolResult.kind === "aggregate"
          ? `${largeToolResult.label}: ${largeToolResult.tokens} tokens — use offset/limit`
          : `Tool result #${largeToolResult.label}: ${largeToolResult.tokens} tokens — use offset/limit`,
      estimatedSavings: Math.floor(largeToolResult.tokens * 0.5),
    });
  }

  return sortSuggestions(suggestions);
}
