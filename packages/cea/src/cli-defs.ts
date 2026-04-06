import type { ArgsDef } from "citty";
import type { ProviderType } from "./agent";
import { parseReasoningMode, type ReasoningMode } from "./reasoning-mode";
import {
  DEFAULT_TOOL_FALLBACK_MODE,
  LEGACY_ENABLED_TOOL_FALLBACK_MODE,
  parseToolFallbackMode,
  TOOL_FALLBACK_MODES,
  type ToolFallbackMode,
} from "./tool-fallback-mode";

export const sharedArgsDef = {
  model: {
    type: "string",
    alias: "m",
    description: "Model ID",
  },
  provider: {
    type: "enum",
    options: ["anthropic"],
    description: "Provider type",
  },
  "reasoning-mode": {
    type: "enum",
    options: ["off", "on", "interleaved", "preserved"],
    description: "Reasoning mode",
  },
  think: {
    type: "boolean",
    description: "Shortcut for --reasoning-mode on",
  },
  "toolcall-mode": {
    type: "enum",
    options: [...TOOL_FALLBACK_MODES],
    description:
      "Tool call fallback mode (also accepts legacy --tool-fallback)",
  },
  translate: {
    type: "boolean",
    default: true,
    description: "Enable user prompt translation",
    negativeDescription: "Disable user prompt translation",
  },
} satisfies ArgsDef;

const hasValue = (value: string | undefined): value is string => {
  return typeof value === "string" && !value.startsWith("--");
};

export const normalizeRawArgs = (rawArgs: string[]): string[] => {
  const normalized: string[] = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === "--tool-fallback") {
      const candidate = rawArgs[index + 1];
      if (!hasValue(candidate)) {
        normalized.push("--toolcall-mode", LEGACY_ENABLED_TOOL_FALLBACK_MODE);
        continue;
      }

      const parsed = parseToolFallbackMode(candidate);
      normalized.push(
        "--toolcall-mode",
        parsed ?? LEGACY_ENABLED_TOOL_FALLBACK_MODE
      );
      index += 1;
      continue;
    }

    if (arg === "--reasoning-mode") {
      const candidate = rawArgs[index + 1];
      if (!hasValue(candidate)) {
        normalized.push(arg);
        continue;
      }

      const parsed = parseReasoningMode(candidate);
      normalized.push(arg, parsed ?? candidate);
      index += 1;
      continue;
    }

    if (arg === "--toolcall-mode") {
      const candidate = rawArgs[index + 1];
      if (!hasValue(candidate)) {
        normalized.push(arg);
        continue;
      }

      const parsed = parseToolFallbackMode(candidate);
      normalized.push(arg, parsed ?? candidate);
      index += 1;
      continue;
    }

    normalized.push(arg);
  }

  return normalized;
};

export interface SharedConfig {
  model: string | null;
  provider: ProviderType | null;
  reasoningMode: ReasoningMode | null;
  toolFallbackMode: ToolFallbackMode;
  translateUserPrompts: boolean;
}

export interface SharedArgs {
  model?: string;
  provider?: ProviderType;
  "reasoning-mode"?: ReasoningMode;
  think?: boolean;
  "toolcall-mode"?: ToolFallbackMode;
  translate?: boolean;
}

export const resolveSharedConfig = (args: SharedArgs): SharedConfig => {
  const explicitReasoningMode = args["reasoning-mode"];

  return {
    model: args.model ?? null,
    provider: args.provider ?? null,
    reasoningMode:
      explicitReasoningMode ?? (args.think ? ("on" as const) : null),
    toolFallbackMode: args["toolcall-mode"] ?? DEFAULT_TOOL_FALLBACK_MODE,
    translateUserPrompts: args.translate ?? true,
  };
};
