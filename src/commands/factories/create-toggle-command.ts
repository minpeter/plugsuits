import { colorize } from "../../interaction/colors";
import type { Command, CommandResult } from "../types";

export interface ToggleCommandConfig {
  description: string;
  disabledMessage?: string;
  enabledMessage?: string;
  featureName: string;
  getter: () => boolean;
  name: string;
  setter: (value: boolean) => void;
}

export function createToggleCommand(config: ToggleCommandConfig): Command {
  const {
    name,
    description,
    getter,
    setter,
    featureName,
    enabledMessage,
    disabledMessage,
  } = config;

  return {
    name,
    description,
    argumentSuggestions: ["on", "off"],
    execute: ({ args }): CommandResult => {
      if (args.length === 0) {
        const currentStatus = getter();
        return {
          success: true,
          message: `${featureName} is currently ${colorize(currentStatus ? "green" : "red", currentStatus ? "enabled" : "disabled")}.\nUsage: /${name} <on|off>`,
        };
      }

      const action = args[0]?.toLowerCase();

      if (action === "on" || action === "enable" || action === "true") {
        setter(true);
        return {
          success: true,
          message: colorize(
            "green",
            enabledMessage || `${featureName} enabled`
          ),
        };
      }

      if (action === "off" || action === "disable" || action === "false") {
        setter(false);
        return {
          success: true,
          message: colorize(
            "yellow",
            disabledMessage || `${featureName} disabled`
          ),
        };
      }

      return {
        success: false,
        message: `Invalid argument: ${action}. Use 'on' or 'off'.`,
      };
    },
  };
}
