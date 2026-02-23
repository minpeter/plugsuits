export const MANUAL_TOOL_LOOP_MAX_STEPS = 200;

const CONTINUATION_FINISH_REASONS = new Set(["tool-calls", "unknown"]);

export const shouldContinueManualToolLoop = (finishReason: string): boolean => {
  return CONTINUATION_FINISH_REASONS.has(finishReason);
};
