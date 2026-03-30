const REPEAT_THRESHOLD = 3;
const WINDOW_MS = 2 * 60 * 1000;

interface CallState {
  count: number;
  lastSeenAt: number;
}

const recentCalls = new Map<string, CallState>();

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${key}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function recordReadOnlyToolCall(
  toolName: string,
  input: Record<string, unknown>
): { repeatCount: number; suppress: boolean } {
  const now = Date.now();
  const key = `${toolName}:${stableStringify(input)}`;
  const state = recentCalls.get(key);
  const nextCount =
    state && now - state.lastSeenAt <= WINDOW_MS ? state.count + 1 : 1;

  recentCalls.set(key, {
    count: nextCount,
    lastSeenAt: now,
  });

  return {
    repeatCount: nextCount,
    suppress: nextCount >= REPEAT_THRESHOLD,
  };
}

export function resetReadOnlyToolCallGuard(): void {
  recentCalls.clear();
}
