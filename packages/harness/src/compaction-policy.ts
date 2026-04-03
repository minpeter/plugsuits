export interface CompactionPolicyInput {
  currentUsageTokens: number;
  enabled: boolean;
  hasMessages: boolean;
  phaseReserveTokens: number;
  speculativeStartRatio?: number;
  thresholdRatio?: number;
}

export interface ContextBudget {
  autoCompactAt: number;
  effectiveContextWindow: number;
  hardLimitAt: number;
  rawContextWindow: number;
  reservedForCompaction: number;
  speculativeStartAt: number;
  warningAt: number;
}

const DEFAULT_COMPACTION_OUTPUT_RESERVE_RATIO = 0.1;
const MAX_COMPACTION_OUTPUT_RESERVE = 20_000;
const MIN_COMPACTION_OUTPUT_RESERVE = 500;
const WARNING_BUFFER_RATIO = 0.15;

export function computeContextBudget(params: {
  contextLimit: number;
  maxOutputTokens?: number;
  reserveTokens?: number;
  thresholdRatio?: number;
}): ContextBudget {
  const {
    contextLimit,
    maxOutputTokens,
    reserveTokens = 0,
    thresholdRatio = 0.5,
  } = params;

  const compactionReserve = Math.min(
    MAX_COMPACTION_OUTPUT_RESERVE,
    Math.max(
      MIN_COMPACTION_OUTPUT_RESERVE,
      Math.floor(contextLimit * DEFAULT_COMPACTION_OUTPUT_RESERVE_RATIO)
    )
  );

  const effectiveWindow = Math.max(0, contextLimit - compactionReserve);
  const autoCompactAt = Math.floor(effectiveWindow * thresholdRatio);
  const warningAt = Math.floor(effectiveWindow * (1 - WARNING_BUFFER_RATIO));
  const hardLimitAt = Math.max(
    0,
    contextLimit - (maxOutputTokens ?? reserveTokens)
  );
  const speculativeStartAt = Math.floor(autoCompactAt * 0.75);

  return {
    autoCompactAt,
    effectiveContextWindow: effectiveWindow,
    hardLimitAt,
    rawContextWindow: contextLimit,
    reservedForCompaction: compactionReserve,
    speculativeStartAt,
    warningAt,
  };
}

export type ContextPressureLevel =
  | "normal"
  | "elevated"
  | "warning"
  | "critical";

export function getContextPressureLevel(
  currentTokens: number,
  budget: ContextBudget
): ContextPressureLevel {
  if (currentTokens >= budget.hardLimitAt) {
    return "critical";
  }
  if (currentTokens >= budget.warningAt) {
    return "warning";
  }
  if (currentTokens >= budget.autoCompactAt) {
    return "elevated";
  }
  return "normal";
}

export function shouldStartSpeculativeCompaction(params: {
  contextLimit: number;
  input: CompactionPolicyInput;
}): boolean {
  const { contextLimit, input } = params;
  if (!(input.enabled && input.hasMessages)) {
    return false;
  }

  const hasValidThresholdRatio =
    typeof input.thresholdRatio === "number" &&
    Number.isFinite(input.thresholdRatio) &&
    input.thresholdRatio > 0;

  if (hasValidThresholdRatio) {
    const speculativeThreshold =
      contextLimit * (input.thresholdRatio as number) * 0.75;
    return input.currentUsageTokens >= speculativeThreshold;
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
  contextLimit: number;
  thresholdRatio?: number;
  enabled: boolean;
  hasMessages: boolean;
}): boolean {
  const {
    currentUsageTokens,
    contextLimit,
    thresholdRatio = 0.5,
    enabled,
    hasMessages,
  } = params;
  if (!(enabled && hasMessages)) {
    return false;
  }

  const normalizedThresholdRatio =
    Number.isFinite(thresholdRatio) && thresholdRatio > 0 && thresholdRatio <= 1
      ? thresholdRatio
      : 0.5;
  const thresholdLimit = contextLimit * normalizedThresholdRatio;

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

  const cappedReserve = Math.min(
    reserveTokens,
    Math.floor(contextLimit * 0.15)
  );
  const remaining = contextLimit - estimatedInputTokens - cappedReserve;
  return Math.max(0, Math.floor(remaining * safetyMargin));
}

export function computeAdaptiveThresholdRatio(contextLength: number): number {
  if (!(contextLength > 0)) {
    return 0.5;
  }

  if (contextLength <= 16_000) {
    return 0.45;
  }
  if (contextLength <= 32_000) {
    return 0.5;
  }
  if (contextLength <= 64_000) {
    return 0.55;
  }
  if (contextLength <= 128_000) {
    return 0.6;
  }
  return 0.65;
}

export function computeCompactionMaxTokens(
  contextLength: number,
  reserveTokens: number
): number {
  if (!(contextLength > 0)) {
    return 8000;
  }

  const usableInputBudget = Math.max(
    1,
    contextLength - Math.max(0, reserveTokens)
  );
  return Math.max(1024, Math.floor(usableInputBudget * 0.8));
}

export function computeSpeculativeStartRatio(
  contextLength: number,
  reserveTokens: number
): number {
  if (!(contextLength > 0)) {
    return 0.75;
  }

  const softBudget = computeCompactionMaxTokens(contextLength, reserveTokens);
  const speculativeThreshold = Math.max(512, Math.floor(softBudget * 0.75));
  return Math.max(0.15, Math.min(0.95, speculativeThreshold / softBudget));
}

/**
 * Returns true if the error indicates a context length exceeded error from a provider.
 * Used to trigger emergency overflow recovery compaction.
 */
export function shouldCompactFromContextOverflow(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes("context_length_exceeded") ||
    msg.includes("context length exceeded") ||
    msg.includes("context window") ||
    msg.includes("maximum context") ||
    msg.includes("too many tokens") ||
    msg.includes("input is too long") ||
    msg.includes("prompt is too long") ||
    msg.includes("tokens exceeds") ||
    msg.includes("token limit")
  );
}
