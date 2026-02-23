export const MANUAL_TOOL_LOOP_MAX_STEPS = 200;

const CONTINUATION_FINISH_REASONS = new Set(["tool-calls"]);
const FINISH_REASON_ALIASES = new Map([
  ["tool_calls", "tool-calls"],
  ["tool_use", "tool-calls"],
  ["function_call", "tool-calls"],
]);

export const normalizeFinishReason = (finishReason: string): string => {
  const normalized = finishReason.trim().toLowerCase();
  return FINISH_REASON_ALIASES.get(normalized) ?? normalized;
};

export const shouldContinueManualToolLoop = (finishReason: string): boolean => {
  return CONTINUATION_FINISH_REASONS.has(normalizeFinishReason(finishReason));
};
