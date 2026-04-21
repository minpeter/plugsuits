import type { Command, CommandResult } from "./commands";
import type { LayeredPreferences } from "./preferences-store";

const DEFAULT_TRUTHY_VALUES = ["on", "enable", "true"] as const;
const DEFAULT_FALSY_VALUES = ["off", "disable", "false"] as const;

const toTitleCase = (value: string): string =>
  value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const applyFieldChange = async <T extends object, K extends keyof T, V>(
  preferences: LayeredPreferences<T>,
  field: K,
  next: V,
  previous: V,
  setRuntime: (value: V) => void | Promise<void>,
  featureName: string
): Promise<CommandResult | null> => {
  try {
    await preferences.patch({ [field]: next } as unknown as Partial<T>);
  } catch (error) {
    return {
      success: false,
      message: `Failed to persist ${featureName.toLowerCase()}: ${formatError(error)}`,
    };
  }

  try {
    await setRuntime(next);
  } catch (error) {
    await preferences
      .patch({ [field]: previous } as unknown as Partial<T>)
      .catch(() => undefined);
    return {
      success: false,
      message: `Failed to apply ${featureName.toLowerCase()}: ${formatError(error)}`,
    };
  }

  return null;
};

export interface TogglePreferenceCommandConfig<
  T extends object,
  K extends keyof T,
> {
  aliases?: string[];
  description?: string;
  disabledMessage?: string;
  enabledMessage?: string;
  falsyValues?: readonly string[];
  featureName?: string;
  field: K;
  get: () => boolean;
  name: string;
  preferences: LayeredPreferences<T>;
  set: (next: boolean) => void | Promise<void>;
  truthyValues?: readonly string[];
}

const parseToggleArgument = (
  raw: string,
  truthy: Set<string>,
  falsy: Set<string>
): boolean | null => {
  if (truthy.has(raw)) {
    return true;
  }
  if (falsy.has(raw)) {
    return false;
  }
  return null;
};

export function createTogglePreferenceCommand<
  T extends object,
  K extends keyof T,
>(config: TogglePreferenceCommandConfig<T, K>): Command {
  const featureName = config.featureName ?? toTitleCase(config.name);
  const truthy = new Set(config.truthyValues ?? DEFAULT_TRUTHY_VALUES);
  const falsy = new Set(config.falsyValues ?? DEFAULT_FALSY_VALUES);
  const description =
    config.description ?? `Toggle ${featureName.toLowerCase()} (on/off).`;

  return {
    name: config.name,
    aliases: config.aliases,
    description,
    argumentSuggestions: ["on", "off"],
    execute: async ({ args }): Promise<CommandResult> => {
      const raw = args[0]?.toLowerCase();
      if (!raw) {
        const current = config.get();
        return {
          success: true,
          message: `${featureName} is ${current ? "enabled" : "disabled"}. Usage: /${config.name} <on|off>`,
        };
      }

      const next = parseToggleArgument(raw, truthy, falsy);
      if (next === null) {
        return {
          success: false,
          message: `Invalid argument: ${raw}. Use 'on' or 'off'.`,
        };
      }

      const failure = await applyFieldChange(
        config.preferences,
        config.field,
        next,
        config.get(),
        config.set,
        featureName
      );
      if (failure) {
        return failure;
      }

      return {
        success: true,
        message: next
          ? (config.enabledMessage ?? `${featureName} enabled.`)
          : (config.disabledMessage ?? `${featureName} disabled.`),
      };
    },
  };
}

export interface EnumPreferenceCommandConfig<
  T extends object,
  K extends keyof T,
  V extends string,
> {
  aliases?: string[];
  description?: string;
  featureName?: string;
  field: K;
  get: () => V;
  name: string;
  parse?: (raw: string) => V | null;
  preferences: LayeredPreferences<T>;
  set: (next: V) => void | Promise<void>;
  validate?: (next: V) => { ok: true } | { ok: false; message: string };
  values: readonly V[];
}

const buildDefaultEnumParser =
  <V extends string>(values: readonly V[]) =>
  (raw: string): V | null => {
    const normalized = raw.toLowerCase();
    return values.find((value) => value.toLowerCase() === normalized) ?? null;
  };

export function createEnumPreferenceCommand<
  T extends object,
  K extends keyof T,
  V extends string,
>(config: EnumPreferenceCommandConfig<T, K, V>): Command {
  const featureName = config.featureName ?? toTitleCase(config.name);
  const usage = config.values.join("|");
  const description =
    config.description ?? `Set ${featureName.toLowerCase()} (${usage}).`;
  const parse = config.parse ?? buildDefaultEnumParser(config.values);

  return {
    name: config.name,
    aliases: config.aliases,
    description,
    argumentSuggestions: [...config.values],
    execute: async ({ args }): Promise<CommandResult> => {
      if (args.length === 0) {
        const current = config.get();
        return {
          success: true,
          message: `${featureName}: ${current}\nUsage: /${config.name} <${usage}>`,
        };
      }

      const raw = args[0] ?? "";
      const next = parse(raw);
      if (next === null) {
        return {
          success: false,
          message: `Invalid value: ${raw}. Use one of: ${usage}`,
        };
      }

      if (config.validate) {
        const verdict = config.validate(next);
        if (!verdict.ok) {
          return { success: false, message: verdict.message };
        }
      }

      const current = config.get();
      if (current === next) {
        return {
          success: true,
          message: `Already set to ${next}.`,
        };
      }

      const failure = await applyFieldChange(
        config.preferences,
        config.field,
        next,
        current,
        config.set,
        featureName
      );
      if (failure) {
        return failure;
      }

      return {
        success: true,
        message: `${featureName} set to: ${next}.`,
      };
    },
  };
}
