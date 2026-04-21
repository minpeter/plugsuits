import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PreferencesStore<T> {
  clear(): Promise<void>;
  load(): Promise<T | null>;
  save(preferences: T): Promise<void>;
}

export class InMemoryPreferencesStore<T> implements PreferencesStore<T> {
  private value: T | null = null;

  load(): Promise<T | null> {
    return Promise.resolve(this.value);
  }

  save(preferences: T): Promise<void> {
    this.value = preferences;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.value = null;
    return Promise.resolve();
  }
}

export interface FilePreferencesStoreOptions<T> {
  filePath: string;
  validate?: (value: unknown) => T | null;
}

export class FilePreferencesStore<T> implements PreferencesStore<T> {
  private readonly filePath: string;
  private readonly validate?: (value: unknown) => T | null;

  constructor(options: FilePreferencesStoreOptions<T>) {
    this.filePath = options.filePath;
    this.validate = options.validate;
  }

  load(): Promise<T | null> {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Promise.resolve(null);
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return Promise.resolve(null);
    }

    if (this.validate) {
      return Promise.resolve(this.validate(parsed));
    }
    return Promise.resolve(parsed as T);
  }

  save(preferences: T): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempFilePath = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(
      tempFilePath,
      `${JSON.stringify(preferences, null, 2)}\n`,
      "utf8"
    );
    renameSync(tempFilePath, this.filePath);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    try {
      rmSync(this.filePath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return Promise.resolve();
  }
}

export interface LayeredPreferencesStoreOptions<T> {
  merge: (accumulator: T | null, next: T | null) => T | null;
  stores: PreferencesStore<T>[];
  writeLayerIndex?: number;
}

export class LayeredPreferencesStore<T> implements PreferencesStore<T> {
  private readonly stores: PreferencesStore<T>[];
  private readonly merge: (accumulator: T | null, next: T | null) => T | null;
  private readonly writeLayerIndex: number;

  constructor(options: LayeredPreferencesStoreOptions<T>) {
    if (options.stores.length === 0) {
      throw new Error(
        "LayeredPreferencesStore requires at least one underlying store"
      );
    }
    this.stores = options.stores;
    this.merge = options.merge;
    this.writeLayerIndex = options.writeLayerIndex ?? options.stores.length - 1;
    if (
      this.writeLayerIndex < 0 ||
      this.writeLayerIndex >= this.stores.length
    ) {
      throw new Error(
        `LayeredPreferencesStore writeLayerIndex ${this.writeLayerIndex} is out of range`
      );
    }
  }

  async load(): Promise<T | null> {
    let acc: T | null = null;
    for (const store of this.stores) {
      const next = await store.load();
      acc = this.merge(acc, next);
    }
    return acc;
  }

  save(preferences: T): Promise<void> {
    const target = this.stores[this.writeLayerIndex];
    if (!target) {
      return Promise.reject(
        new Error(
          `LayeredPreferencesStore has no store at writeLayerIndex ${this.writeLayerIndex}`
        )
      );
    }
    return target.save(preferences);
  }

  clear(): Promise<void> {
    const target = this.stores[this.writeLayerIndex];
    if (!target) {
      return Promise.reject(
        new Error(
          `LayeredPreferencesStore has no store at writeLayerIndex ${this.writeLayerIndex}`
        )
      );
    }
    return target.clear();
  }
}

export function shallowMergePreferences<T extends object>(
  accumulator: T | null,
  next: T | null
): T | null {
  if (!next) {
    return accumulator;
  }
  if (!accumulator) {
    return filterUndefined(next);
  }
  return { ...accumulator, ...filterUndefined(next) } as T;
}

function filterUndefined<T extends object>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      result[key] = entry;
    }
  }
  return result as T;
}

export interface LayeredPreferencesPaths {
  userFilePath: string;
  workspaceFilePath: string;
}

export interface CreateLayeredPreferencesOptions<T extends object> {
  appName?: string;
  cwd?: string;
  fileName?: string;
  homeDir?: string;
  merge?: (accumulator: T | null, next: T | null) => T | null;
  userFilePath?: string;
  validate?: (value: unknown) => T | null;
  workspaceFilePath?: string;
}

export interface LayeredPreferences<T extends object> {
  patch: (partial: Partial<T>) => Promise<T>;
  paths: LayeredPreferencesPaths;
  store: PreferencesStore<T>;
  userStore: PreferencesStore<T>;
  workspaceStore: PreferencesStore<T>;
}

export const DEFAULT_LAYERED_PREFERENCES_APP_NAME = "plugsuits";
export const DEFAULT_LAYERED_PREFERENCES_FILE_NAME = "settings.json";

export function createLayeredPreferences<T extends object>(
  options: CreateLayeredPreferencesOptions<T> = {}
): LayeredPreferences<T> {
  const appName = options.appName ?? DEFAULT_LAYERED_PREFERENCES_APP_NAME;
  const fileName = options.fileName ?? DEFAULT_LAYERED_PREFERENCES_FILE_NAME;
  const cwd = options.cwd ?? process.cwd();
  const home = options.homeDir ?? homedir();

  const userFilePath =
    options.userFilePath ?? join(home, `.${appName}`, fileName);
  const workspaceFilePath =
    options.workspaceFilePath ?? join(cwd, `.${appName}`, fileName);

  const userStore = new FilePreferencesStore<T>({
    filePath: userFilePath,
    validate: options.validate,
  });
  const workspaceStore = new FilePreferencesStore<T>({
    filePath: workspaceFilePath,
    validate: options.validate,
  });

  const store = new LayeredPreferencesStore<T>({
    stores: [userStore, workspaceStore],
    merge: options.merge ?? shallowMergePreferences,
  });

  let patchQueue: Promise<unknown> = Promise.resolve();
  const patch = (partial: Partial<T>): Promise<T> => {
    const next = patchQueue.then(async () => {
      const existing = (await workspaceStore.load()) ?? ({} as T);
      const merged: T = { ...(existing as object) } as T;
      for (const [key, value] of Object.entries(partial as object)) {
        if (value !== undefined) {
          (merged as Record<string, unknown>)[key] = value;
        }
      }
      await workspaceStore.save(merged);
      return merged;
    });
    patchQueue = next.catch(() => undefined);
    return next;
  };

  return {
    paths: { userFilePath, workspaceFilePath },
    patch,
    store,
    userStore,
    workspaceStore,
  };
}
