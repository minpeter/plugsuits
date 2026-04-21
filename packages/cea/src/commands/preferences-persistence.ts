import type {
  LayeredPreferences,
  PreferencesStore,
} from "@ai-sdk-tool/harness";
import {
  patchWorkspacePreferences,
  type UserPreferences,
} from "../user-preferences";

type WorkspacePreferencesStore = PreferencesStore<UserPreferences>;

let preferencesBundle: LayeredPreferences<UserPreferences> | null = null;
let workspacePreferencesStore: WorkspacePreferencesStore | null = null;
let onPersistError: ((error: unknown) => void) | null = null;

export const configurePreferencesPersistence = (options: {
  bundle?: LayeredPreferences<UserPreferences>;
  onError?: (error: unknown) => void;
  workspaceStore: WorkspacePreferencesStore;
}): void => {
  preferencesBundle = options.bundle ?? null;
  workspacePreferencesStore = options.workspaceStore;
  onPersistError = options.onError ?? null;
};

export const resetPreferencesPersistenceForTesting = (): void => {
  preferencesBundle = null;
  workspacePreferencesStore = null;
  onPersistError = null;
};

export const getPreferencesBundle =
  (): LayeredPreferences<UserPreferences> | null => preferencesBundle;

const handlePersistError = (error: unknown): void => {
  if (onPersistError) {
    onPersistError(error);
    return;
  }
  console.error("[preferences] Failed to persist workspace settings:", error);
};

export const persistPreferencePatch = (patch: UserPreferences): void => {
  if (!workspacePreferencesStore) {
    return;
  }
  const store = workspacePreferencesStore;
  patchWorkspacePreferences(store, patch).catch(handlePersistError);
};
