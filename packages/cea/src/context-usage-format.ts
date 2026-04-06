import {
  type ContextUsage,
  computeContextBudget,
  getContextPressureLevel,
} from "@ai-sdk-tool/harness";

export const formatTokens = (n: number): string => {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
};

const PRESSURE_LABELS: Record<string, string> = {
  normal: "",
  elevated: " [elevated]",
  warning: " [WARNING]",
  critical: " [CRITICAL]",
};

export const formatContextUsage = (
  contextUsage: ContextUsage,
  opts?: { reserveTokens?: number; thresholdRatio?: number }
): string => {
  if (contextUsage.limit <= 0) {
    return `?/${formatTokens(contextUsage.limit)} (?)`;
  }

  const budget = computeContextBudget({
    contextLimit: contextUsage.limit,
    reserveTokens: opts?.reserveTokens,
    thresholdRatio: opts?.thresholdRatio,
  });
  const pressure = getContextPressureLevel(contextUsage.used, budget);
  const label = PRESSURE_LABELS[pressure] ?? "";

  return `${formatTokens(contextUsage.used)}/${formatTokens(contextUsage.limit)} (${contextUsage.percentage}%)${label}`;
};
