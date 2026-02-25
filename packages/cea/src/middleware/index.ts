import type { LanguageModelV3Middleware } from "@ai-sdk/provider";
import {
  hermesToolMiddleware,
  morphXmlToolMiddleware,
  qwen3CoderToolMiddleware,
} from "@ai-sdk-tool/parser";
import type { ToolFallbackMode } from "../tool-fallback-mode";
import { trimLeadingNewlinesMiddleware as trimMiddleware } from "./trim-leading-newlines";

export interface MiddlewareOptions {
  toolFallbackMode: ToolFallbackMode;
}

const TOOL_FALLBACK_MIDDLEWARES: Readonly<
  Record<Exclude<ToolFallbackMode, "disable">, LanguageModelV3Middleware>
> = {
  morphxml: morphXmlToolMiddleware,
  hermes: hermesToolMiddleware,
  qwen3coder: qwen3CoderToolMiddleware,
};

export function buildMiddlewares(
  options: MiddlewareOptions
): LanguageModelV3Middleware[] {
  const middlewares: LanguageModelV3Middleware[] = [trimMiddleware];

  if (options.toolFallbackMode !== "disable") {
    middlewares.push(TOOL_FALLBACK_MIDDLEWARES[options.toolFallbackMode]);
  }

  return middlewares;
}
