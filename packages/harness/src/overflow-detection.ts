/**
 * Provider-specific context overflow error detection.
 * Detects when LLM API responses indicate context window exhaustion.
 *
 * Pattern coverage:
 * - Anthropic: prompt is too long, context_length_exceeded, too many tokens
 * - OpenAI/Friendli: maximum context length, context length exceeded, token limit
 * - Google/Gemini: exceeds the context window, context window, input too long
 * - Generic: input is too long (shared pattern)
 */

/**
 * Regex patterns for detecting context overflow errors from LLM providers.
 * Max 15 patterns total: prioritizes Anthropic + OpenAI + Google/Gemini.
 */
const OVERFLOW_PATTERNS: RegExp[] = [
  // Anthropic (3 patterns)
  /prompt is too long/i,
  /context_length_exceeded/i,
  /too many tokens/i,

  // OpenAI / Friendli (4 patterns)
  /maximum context length/i,
  /context length exceeded/i,
  /token limit exceeded/i,
  /tokens exceeds the context window/i,

  // Google / Gemini (3 patterns)
  /exceeds the context window/i,
  /context window/i,
  /input too long/i,

  // Generic / shared (2 patterns)
  /input is too long/i,
  /token limit/i,
];

/**
 * Checks if an error is a context overflow error from any supported LLM provider.
 *
 * @param error - The error object to check
 * @returns true if the error matches a known context overflow pattern
 *
 * @example
 * ```typescript
 * try {
 *   await streamText({ model, messages });
 * } catch (error) {
 *   if (isContextOverflowError(error)) {
 *     console.log("Context window exceeded");
 *   }
 * }
 * ```
 */
export function isContextOverflowError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Detects "silent" context overflow by comparing input token usage to context window size.
 * Silent overflows occur when the input tokens exceed the context window,
 * but the API doesn't explicitly reject the request.
 *
 * @param usage - Token usage object with inputTokens (or legacy promptTokens alias)
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
  usage: { inputTokens?: number; promptTokens?: number },
  contextWindow: number
): boolean {
  const tokens = usage.inputTokens ?? usage.promptTokens ?? 0;
  return tokens > contextWindow;
}
