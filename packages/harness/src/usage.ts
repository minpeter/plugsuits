/**
 * Normalize usage measurement from various input formats.
 * Handles canonical token field names.
 */
export interface UsageMeasurement {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function getUsageNumber(
  usage: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

export function normalizeUsageMeasurement(
  usage: UsageMeasurement | null | undefined
): UsageMeasurement | null {
  if (!usage) {
    return null;
  }

  const usageRecord = usage as Record<string, unknown>;
  const inputTokens = getUsageNumber(usageRecord, "inputTokens");
  const outputTokens = getUsageNumber(usageRecord, "outputTokens");
  const totalTokens = getUsageNumber(usageRecord, "totalTokens");

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}
