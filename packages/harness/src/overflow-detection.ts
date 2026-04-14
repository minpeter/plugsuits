/**
 * Provider-specific context overflow error detection.
 * Detects when LLM API responses indicate context window exhaustion.
 *
 * Pattern coverage:
 * - Anthropic: prompt is too long, context_length_exceeded, too many tokens
 * - OpenAI-compatible: maximum context length, context length exceeded, token limit
 * - Google/Gemini: exceeds the context window, context window, input too long
 * - Generic: input is too long (shared pattern)
 */

/**
 * Regex patterns for detecting context overflow errors from LLM providers.
 * Max 15 patterns total: prioritizes Anthropic + OpenAI + Google/Gemini.
 */
const HIGH_CONFIDENCE_PATTERNS: RegExp[] = [
  // Anthropic (2 patterns - most specific)
  /context_length_exceeded/i,
  /prompt is too long/i,

  // OpenAI-compatible (2 patterns)
  /maximum context length/i,
  /context length exceeded/i,
];

const MEDIUM_CONFIDENCE_PATTERNS: RegExp[] = [
  // OpenAI-compatible
  /token limit exceeded/i,
  /tokens exceeds the context window/i,

  // Google / Gemini
  /exceeds the context window/i,
];

const LOW_CONFIDENCE_PATTERNS: RegExp[] = [
  // Generic / shared (less specific)
  /context window/i,
  /input too long/i,
  /input is too long/i,
  /token limit/i,
  /too many tokens/i,
];

/**
 * Detects context overflow errors with confidence levels.
 *
 * @param error - The error object to check
 * @returns An object with `detected` boolean and `confidence` level ("high" | "medium" | "low")
 *
 * @example
 * ```typescript
 * try {
 *   await streamText({ model, messages });
 * } catch (error) {
 *   const result = isContextOverflowError(error);
 *   if (result.detected && result.confidence === "high") {
 *     console.log("Definite context overflow — apply recovery");
 *   }
 * }
 * ```
 */
export function isContextOverflowError(error: unknown): {
  detected: boolean;
  confidence: "high" | "medium" | "low";
} {
  if (!(error instanceof Error)) {
    return { detected: false, confidence: "low" };
  }

  const message = error.message;

  if (HIGH_CONFIDENCE_PATTERNS.some((pattern) => pattern.test(message))) {
    return { detected: true, confidence: "high" };
  }

  const mediumMatches = MEDIUM_CONFIDENCE_PATTERNS.filter((pattern) =>
    pattern.test(message)
  ).length;
  if (mediumMatches >= 2) {
    return { detected: true, confidence: "medium" };
  }

  if (LOW_CONFIDENCE_PATTERNS.some((pattern) => pattern.test(message))) {
    return { detected: true, confidence: "low" };
  }

  return { detected: false, confidence: "low" };
}

/**
 * Detects "silent" context overflow by comparing input token usage to context window size.
 * Silent overflows occur when the input tokens exceed the context window,
 * but the API doesn't explicitly reject the request.
 *
 * @param usage - Token usage object with inputTokens
 * @param contextWindow - The LLM's context window size
 * @returns true if input tokens exceed the context window
 *
 * @example
 * ```typescript
 * const usage = { inputTokens: 200_000 };
 * const contextWindow = 128_000;
 * if (isUsageSilentOverflow(usage, contextWindow)) {
 *   console.log("Silent overflow detected");
 * }
 * ```
 */
export function isUsageSilentOverflow(
  usage: { inputTokens?: number },
  contextWindow: number
): boolean {
  const tokens = usage.inputTokens ?? 0;
  return tokens > contextWindow;
}
