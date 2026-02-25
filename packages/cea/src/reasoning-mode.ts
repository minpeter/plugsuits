export const REASONING_MODES = [
  "off",
  "on",
  "interleaved",
  "preserved",
] as const;

export type ReasoningMode = (typeof REASONING_MODES)[number];

export const DEFAULT_REASONING_MODE: ReasoningMode = "off";

const isReasoningMode = (value: string): value is ReasoningMode => {
  return REASONING_MODES.includes(value as ReasoningMode);
};

export const parseReasoningMode = (rawValue: string): ReasoningMode | null => {
  const value = rawValue.toLowerCase();

  if (isReasoningMode(value)) {
    return value;
  }

  if (value === "enable" || value === "true") {
    return "on";
  }

  if (value === "disable" || value === "false") {
    return "off";
  }

  if (value === "interleave") {
    return "interleaved";
  }

  if (value === "preserve") {
    return "preserved";
  }

  return null;
};
