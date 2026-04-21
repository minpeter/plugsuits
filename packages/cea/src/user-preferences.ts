import {
  createLayeredPreferences,
  type LayeredPreferences,
  type PreferencesStore,
} from "@ai-sdk-tool/harness";
import { z } from "zod";
import { REASONING_MODES, type ReasoningMode } from "./reasoning-mode";
import {
  TOOL_FALLBACK_MODES,
  type ToolFallbackMode,
} from "./tool-fallback-mode";

const USER_PREFERENCES_SCHEMA_VERSION = 1;
const USER_PREFERENCES_APP_NAME = "plugsuits";

const userPreferencesSchema = z
  .object({
    schemaVersion: z.literal(USER_PREFERENCES_SCHEMA_VERSION).optional(),
    translateEnabled: z.boolean().optional(),
    reasoningMode: z.enum(REASONING_MODES).optional(),
    toolFallbackMode: z.enum(TOOL_FALLBACK_MODES).optional(),
  })
  .partial()
  .strip();

export interface UserPreferences {
  reasoningMode?: ReasoningMode;
  toolFallbackMode?: ToolFallbackMode;
  translateEnabled?: boolean;
}

interface StoredUserPreferences extends UserPreferences {
  schemaVersion?: number;
}

export interface CreateUserPreferencesStoreOptions {
  userFilePath?: string;
  workspaceFilePath?: string;
}

export interface UserPreferencesStoreBundle {
  bundle: LayeredPreferences<UserPreferences>;
  store: PreferencesStore<UserPreferences>;
  userFilePath: string;
  workspaceFilePath: string;
  workspaceStore: PreferencesStore<UserPreferences>;
}

const validateStoredPreferences = (value: unknown): UserPreferences | null => {
  const parsed = userPreferencesSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const { schemaVersion: _ignored, ...rest } =
    parsed.data as StoredUserPreferences;
  const cleaned: UserPreferences = {};
  if (rest.translateEnabled !== undefined) {
    cleaned.translateEnabled = rest.translateEnabled;
  }
  if (rest.reasoningMode !== undefined) {
    cleaned.reasoningMode = rest.reasoningMode;
  }
  if (rest.toolFallbackMode !== undefined) {
    cleaned.toolFallbackMode = rest.toolFallbackMode;
  }
  if (Object.keys(cleaned).length === 0) {
    return null;
  }
  return cleaned;
};

export const createUserPreferencesStore = (
  options: CreateUserPreferencesStoreOptions = {}
): UserPreferencesStoreBundle => {
  const bundle = createLayeredPreferences<UserPreferences>({
    appName: USER_PREFERENCES_APP_NAME,
    userFilePath: options.userFilePath,
    workspaceFilePath: options.workspaceFilePath,
    validate: validateStoredPreferences,
  });
  return {
    bundle,
    store: bundle.store,
    userFilePath: bundle.paths.userFilePath,
    workspaceFilePath: bundle.paths.workspaceFilePath,
    workspaceStore: bundle.workspaceStore,
  };
};

const patchQueues = new WeakMap<
  PreferencesStore<UserPreferences>,
  Promise<unknown>
>();

export const patchWorkspacePreferences = (
  workspaceStore: PreferencesStore<UserPreferences>,
  patch: UserPreferences
): Promise<UserPreferences> => {
  const previous = patchQueues.get(workspaceStore) ?? Promise.resolve();
  const next = previous.then(async () => {
    const existing = (await workspaceStore.load()) ?? {};
    const merged: UserPreferences = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
    await workspaceStore.save(merged);
    return merged;
  });
  patchQueues.set(
    workspaceStore,
    next.catch(() => undefined)
  );
  return next;
};

export const withStoredSchemaVersion = (
  preferences: UserPreferences
): StoredUserPreferences => ({
  schemaVersion: USER_PREFERENCES_SCHEMA_VERSION,
  ...preferences,
});
