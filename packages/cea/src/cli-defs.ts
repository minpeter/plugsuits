import type { ArgsDef } from "citty";
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

const hasValue = (value: string | undefined): value is string =>
  typeof value === "string" && !value.startsWith("--");

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
  reasoningMode: ReasoningMode | null;
  toolFallbackMode: ToolFallbackMode | null;
  toolFallbackModeExplicit: boolean;
  translateUserPrompts: boolean | null;
}

export interface SharedArgs {
  model?: string;
  "reasoning-mode"?: ReasoningMode;
  think?: boolean;
  "toolcall-mode"?: ToolFallbackMode;
  translate?: boolean;
}

export interface ResolveSharedConfigOptions {
  rawArgs?: readonly string[];
}

const rawArgMatches = (arg: string, ...names: string[]): boolean => {
  for (const name of names) {
    if (arg === name) {
      return true;
    }
    if (arg.startsWith(`${name}=`)) {
      return true;
    }
  }
  return false;
};

const hasFlag = (
  rawArgs: readonly string[] | undefined,
  ...names: string[]
): boolean => {
  if (!rawArgs) {
    return false;
  }
  return rawArgs.some((arg) => rawArgMatches(arg, ...names));
};

export const resolveSharedConfig = (
  args: SharedArgs,
  options: ResolveSharedConfigOptions = {}
): SharedConfig => {
  const { rawArgs } = options;
  const explicitReasoningMode = args["reasoning-mode"];

  const translateExplicit = hasFlag(rawArgs, "--translate", "--no-translate");
  const toolFallbackExplicit = hasFlag(
    rawArgs,
    "--toolcall-mode",
    "--tool-fallback"
  );

  let translateUserPrompts: boolean | null = null;
  if (translateExplicit) {
    translateUserPrompts = args.translate ?? true;
  }

  return {
    model: args.model ?? null,
    reasoningMode:
      explicitReasoningMode ?? (args.think ? ("on" as const) : null),
    toolFallbackMode: toolFallbackExplicit
      ? (args["toolcall-mode"] ?? DEFAULT_TOOL_FALLBACK_MODE)
      : null,
    toolFallbackModeExplicit: toolFallbackExplicit,
    translateUserPrompts,
  };
};
