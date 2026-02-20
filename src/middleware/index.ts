import type { LanguageModelV3Middleware } from "@ai-sdk/provider";
import { morphXmlToolMiddleware } from "@ai-sdk-tool/parser";
import { trimLeadingNewlinesMiddleware as trimMiddleware } from "./trim-leading-newlines";

export interface MiddlewareOptions {
  enableToolFallback: boolean;
}

export function buildMiddlewares(
  options: MiddlewareOptions
): LanguageModelV3Middleware[] {
  const middlewares: LanguageModelV3Middleware[] = [trimMiddleware];

  if (options.enableToolFallback) {
    middlewares.push(morphXmlToolMiddleware);
  }

  return middlewares;
}
