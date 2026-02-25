import { agentManager } from "../agent";
import { parseReasoningMode, REASONING_MODES } from "../reasoning-mode";
import type { Command } from "./types";

const REASONING_MODE_USAGE = REASONING_MODES.join("|");

export const createReasoningModeCommand = (): Command => ({
  name: "reasoning-mode",
  aliases: ["think"],
  description: "Set reasoning mode (off/on/interleaved/preserved)",
  argumentSuggestions: [...REASONING_MODES],
  execute: ({ args }) => {
    const selectableModes = agentManager.getSelectableReasoningModes();
    const selectableLabel = selectableModes.join("|");

    if (args.length === 0) {
      const currentMode = agentManager.getReasoningMode();
      return {
        success: true,
        message: `Reasoning mode: ${currentMode}\nSelectable: ${selectableLabel}\nUsage: /reasoning-mode <${REASONING_MODE_USAGE}>`,
      };
    }

    const rawMode = args[0] ?? "";
    const mode = parseReasoningMode(rawMode);
    if (!mode) {
      return {
        success: false,
        message: `Invalid mode: ${rawMode}. Use one of: ${REASONING_MODE_USAGE}`,
      };
    }

    if (!selectableModes.includes(mode)) {
      return {
        success: false,
        message: `Mode ${mode} is not supported for current model. Selectable: ${selectableLabel}`,
      };
    }

    const currentMode = agentManager.getReasoningMode();
    if (mode === currentMode) {
      return {
        success: true,
        message: `Already using reasoning mode: ${mode}`,
      };
    }

    agentManager.setReasoningMode(mode);

    return {
      success: true,
      message: `Reasoning mode set to: ${mode}`,
    };
  },
});
