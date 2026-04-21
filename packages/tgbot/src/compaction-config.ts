import {
  computeAdaptiveThresholdRatio,
  computeCompactionMaxTokens,
  computeSpeculativeStartRatio,
} from "@ai-sdk-tool/harness";

export interface CompactionTokenBudget {
  keepRecentTokens: number;
  maxTokens: number;
  reserveTokens: number;
  speculativeStartRatio: number;
  thresholdRatio: number;
}

export const buildCompactionTokenBudget = (
  contextLimit: number
): CompactionTokenBudget => {
  const normalizedContextLimit = Math.max(1, Math.floor(contextLimit));
  const reserveTokens = Math.max(0, Math.floor(normalizedContextLimit * 0.2));
  const availableInputTokens = Math.max(
    0,
    normalizedContextLimit - reserveTokens
  );
  const maxTokens = Math.min(
    computeCompactionMaxTokens(normalizedContextLimit, reserveTokens),
    availableInputTokens
  );
  const thresholdRatio = computeAdaptiveThresholdRatio(normalizedContextLimit);
  const keepRecentTokens = Math.min(
    availableInputTokens,
    Math.floor(normalizedContextLimit * 0.3),
    Math.max(0, Math.floor(maxTokens * 0.3))
  );

  return {
    keepRecentTokens,
    maxTokens,
    reserveTokens,
    speculativeStartRatio: computeSpeculativeStartRatio(
      normalizedContextLimit,
      reserveTokens
    ),
    thresholdRatio,
  };
};
