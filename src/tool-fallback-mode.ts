export const TOOL_FALLBACK_MODES = [
  "disable",
  "morphxml",
  "hermes",
  "qwen3coder",
] as const;

export type ToolFallbackMode = (typeof TOOL_FALLBACK_MODES)[number];

export const DEFAULT_TOOL_FALLBACK_MODE: ToolFallbackMode = "disable";
export const LEGACY_ENABLED_TOOL_FALLBACK_MODE: ToolFallbackMode = "morphxml";

export const isToolFallbackMode = (
  value: string
): value is ToolFallbackMode => {
  return TOOL_FALLBACK_MODES.includes(value as ToolFallbackMode);
};

export const parseToolFallbackMode = (
  rawValue: string
): ToolFallbackMode | null => {
  const value = rawValue.toLowerCase();
  if (isToolFallbackMode(value)) {
    return value;
  }

  if (value === "on" || value === "enable" || value === "true") {
    return LEGACY_ENABLED_TOOL_FALLBACK_MODE;
  }

  if (value === "off" || value === "disable" || value === "false") {
    return "disable";
  }

  return null;
};
