const CONTINUATION_FINISH_REASONS = new Set(["tool-calls"]);
const FINISH_REASON_ALIASES = new Map([
  ["tool_calls", "tool-calls"],
  ["tool_use", "tool-calls"],
  ["function_call", "tool-calls"],
]);

export type StopPredicate<FinishReason = string, Context = void> = (
  finishReason: FinishReason,
  context?: Context
) => boolean;

export const normalizeFinishReason = (finishReason: string): string => {
  const normalized = finishReason.trim().toLowerCase();
  return FINISH_REASON_ALIASES.get(normalized) ?? normalized;
};

export const shouldContinueManualToolLoop = (finishReason: string): boolean => {
  return CONTINUATION_FINISH_REASONS.has(normalizeFinishReason(finishReason));
};

export const composeStopPredicates = <FinishReason, Context>(
  ...predicates: Array<StopPredicate<FinishReason, Context> | undefined>
): StopPredicate<FinishReason, Context> => {
  const activePredicates = predicates.filter(
    (predicate): predicate is StopPredicate<FinishReason, Context> =>
      predicate !== undefined
  );

  return (finishReason, context) => {
    for (const predicate of activePredicates) {
      if (!predicate(finishReason, context)) {
        return false;
      }
    }

    return true;
  };
};
