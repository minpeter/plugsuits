import type { ProviderType } from "./agent";
import {
  DEFAULT_REASONING_MODE,
  parseReasoningMode,
  type ReasoningMode,
} from "./reasoning-mode";
import {
  DEFAULT_TOOL_FALLBACK_MODE,
  LEGACY_ENABLED_TOOL_FALLBACK_MODE,
  parseToolFallbackMode,
  type ToolFallbackMode,
} from "./tool-fallback-mode";

export type { ProviderType };

export const parseProviderArg = (
  providerArg: string | undefined
): ProviderType | null => {
  if (providerArg === "anthropic" || providerArg === "friendli") {
    return providerArg;
  }
  return null;
};

export const parseTranslateCliOption = (arg: string): boolean | null => {
  if (arg === "--translate") {
    return true;
  }
  if (arg === "--no-translate") {
    return false;
  }
  return null;
};

export const parseReasoningCliOption = (
  args: string[],
  index: number
): { consumedArgs: number; mode: ReasoningMode } | null => {
  const arg = args[index];
  if (arg === "--think") {
    return { consumedArgs: 0, mode: "on" };
  }
  if (arg !== "--reasoning-mode") {
    return null;
  }
  const candidate = args[index + 1];
  if (candidate && !candidate.startsWith("--")) {
    const parsedMode = parseReasoningMode(candidate);
    return {
      consumedArgs: 1,
      mode: parsedMode ?? DEFAULT_REASONING_MODE,
    };
  }
  return {
    consumedArgs: 0,
    mode: DEFAULT_REASONING_MODE,
  };
};

export const parseToolFallbackCliOption = (
  args: string[],
  index: number
): { consumedArgs: number; mode: ToolFallbackMode } | null => {
  const arg = args[index];

  const parseCandidate = (
    fallbackMode: ToolFallbackMode
  ): { consumedArgs: number; mode: ToolFallbackMode } => {
    const candidate = args[index + 1];
    if (!candidate || candidate.startsWith("--")) {
      return {
        consumedArgs: 0,
        mode: fallbackMode,
      };
    }
    const parsedMode = parseToolFallbackMode(candidate);
    return {
      consumedArgs: 1,
      mode: parsedMode ?? fallbackMode,
    };
  };

  if (arg === "--toolcall-mode") {
    return parseCandidate(DEFAULT_TOOL_FALLBACK_MODE);
  }
  if (arg === "--tool-fallback") {
    return parseCandidate(LEGACY_ENABLED_TOOL_FALLBACK_MODE);
  }
  return null;
};
