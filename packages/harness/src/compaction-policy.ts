export interface CompactionPolicyInput {
  currentUsageTokens: number;
  enabled: boolean;
  hasMessages: boolean;
  phaseReserveTokens: number;
  speculativeStartRatio?: number;
}

export function shouldStartSpeculativeCompaction(params: {
  contextLimit: number;
  input: CompactionPolicyInput;
}): boolean {
  const { contextLimit, input } = params;
  if (!(input.enabled && input.hasMessages)) {
    return false;
  }

  const predictiveThreshold =
    typeof input.speculativeStartRatio === "number" &&
    Number.isFinite(input.speculativeStartRatio) &&
    input.speculativeStartRatio > 0 &&
    input.speculativeStartRatio < 1
      ? Math.floor(contextLimit * input.speculativeStartRatio)
      : Math.max(0, contextLimit - input.phaseReserveTokens * 2);

  return input.currentUsageTokens >= predictiveThreshold;
}

export function needsCompactionFromUsage(params: {
  currentUsageTokens: number;
  enabled: boolean;
  hasMessages: boolean;
  thresholdLimit: number;
}): boolean {
  const { currentUsageTokens, enabled, hasMessages, thresholdLimit } = params;
  if (!(enabled && hasMessages)) {
    return false;
  }

  return currentUsageTokens >= thresholdLimit;
}

export function isAtHardContextLimitFromUsage(params: {
  additionalTokens?: number;
  contextLimit: number;
  currentUsageTokens: number;
  enabled: boolean;
  reserveTokens: number;
}): boolean {
  const {
    additionalTokens = 0,
    contextLimit,
    currentUsageTokens,
    enabled,
    reserveTokens,
  } = params;

  if (!enabled) {
    return false;
  }

  return currentUsageTokens + additionalTokens + reserveTokens >= contextLimit;
}

export function getRecommendedMaxOutputTokens(params: {
  contextLimit: number;
  estimatedInputTokens: number;
  reserveTokens: number;
  safetyMargin?: number;
}): number | undefined {
  const {
    contextLimit,
    estimatedInputTokens,
    reserveTokens,
    safetyMargin = 0.85,
  } = params;

  if (contextLimit <= 0) {
    return undefined;
  }

  const remaining = contextLimit - estimatedInputTokens - reserveTokens;
  return Math.max(0, Math.floor(remaining * safetyMargin));
}
