import { agentManager } from "../agent";
import {
  parseToolFallbackMode,
  TOOL_FALLBACK_MODES,
} from "../tool-fallback-mode";
import type { Command } from "./types";

const TOOL_FALLBACK_USAGE = TOOL_FALLBACK_MODES.join("|");

export const createToolFallbackCommand = (): Command => ({
  name: "tool-fallback",
  description:
    "Set tool call fallback mode for models without native tool support",
  argumentSuggestions: [...TOOL_FALLBACK_MODES],
  execute: ({ args }) => {
    if (args.length === 0) {
      const currentMode = agentManager.getToolFallbackMode();
      return {
        success: true,
        message: `Tool fallback mode: ${currentMode}\nUsage: /tool-fallback <${TOOL_FALLBACK_USAGE}>`,
      };
    }

    const rawMode = args[0] ?? "";
    const mode = parseToolFallbackMode(rawMode);
    if (!mode) {
      return {
        success: false,
        message: `Invalid mode: ${rawMode}. Use one of: ${TOOL_FALLBACK_USAGE}`,
      };
    }

    const currentMode = agentManager.getToolFallbackMode();
    if (mode === currentMode) {
      return {
        success: true,
        message: `Already using tool fallback mode: ${mode}`,
      };
    }

    agentManager.setToolFallbackMode(mode);
    return {
      success: true,
      message: `Tool fallback mode set to: ${mode}`,
    };
  },
});
