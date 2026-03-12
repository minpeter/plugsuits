export type { LanguageModelV3Middleware } from "@ai-sdk/provider";

import type { LanguageModelV3Middleware } from "@ai-sdk/provider";

export interface MiddlewareConfig {
  middlewares: LanguageModelV3Middleware[];
}

export function buildMiddlewareChain(
  config: MiddlewareConfig
): LanguageModelV3Middleware[] {
  return config.middlewares;
}
