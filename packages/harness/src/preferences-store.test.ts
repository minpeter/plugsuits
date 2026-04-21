import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLayeredPreferences,
  DEFAULT_LAYERED_PREFERENCES_APP_NAME,
  DEFAULT_LAYERED_PREFERENCES_FILE_NAME,
  FilePreferencesStore,
  InMemoryPreferencesStore,
  LayeredPreferencesStore,
  shallowMergePreferences,
} from "./preferences-store";

const EMPTY_STORES_PATTERN = /at least one/;
const WRITE_LAYER_OUT_OF_RANGE_PATTERN = /out of range/;
const SIMULATED_DISK_FAILURE_PATTERN = /simulated disk failure/;

interface TestPrefs extends Record<string, unknown> {
  reasoningMode?: "off" | "on" | "interleaved";
  toolFallbackMode?: "disable" | "morphxml";
  translateEnabled?: boolean;
}

describe("InMemoryPreferencesStore", () => {
  it("returns null before anything is saved", async () => {
    const store = new InMemoryPreferencesStore<TestPrefs>();
    expect(await store.load()).toBeNull();
  });

  it("save then load returns the same value", async () => {
    const store = new InMemoryPreferencesStore<TestPrefs>();
    await store.save({ translateEnabled: false });
    expect(await store.load()).toEqual({ translateEnabled: false });
  });

  it("clear resets to null", async () => {
    const store = new InMemoryPreferencesStore<TestPrefs>();
    await store.save({ translateEnabled: true });
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

describe("FilePreferencesStore", () => {
  let tmpDir: string;
  let filePath: string;
  let store: FilePreferencesStore<TestPrefs>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "file-prefs-store-test-"));
    filePath = join(tmpDir, "nested", "settings.json");
    store = new FilePreferencesStore<TestPrefs>({ filePath });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", async () => {
    expect(await store.load()).toBeNull();
  });

  it("creates the parent directory when saving", async () => {
    await store.save({ translateEnabled: false });
    expect(existsSync(filePath)).toBe(true);
  });

  it("save then load round-trips the value", async () => {
    await store.save({
      translateEnabled: false,
      reasoningMode: "on",
      toolFallbackMode: "morphxml",
    });
    expect(await store.load()).toEqual({
      translateEnabled: false,
      reasoningMode: "on",
      toolFallbackMode: "morphxml",
    });
  });

  it("save is atomic (no .tmp files are left behind)", async () => {
    await store.save({ translateEnabled: true });
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(join(tmpDir, "nested"));
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("save fully replaces prior state", async () => {
    await store.save({ translateEnabled: true, reasoningMode: "on" });
    await store.save({ translateEnabled: false });
    expect(await store.load()).toEqual({ translateEnabled: false });
  });

  it("treats malformed JSON as no-preferences-stored", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tmpDir, "nested"), { recursive: true });
    writeFileSync(filePath, "{not valid json", "utf8");
    expect(await store.load()).toBeNull();
  });

  it("runs the validator when provided", async () => {
    const validated = new FilePreferencesStore<TestPrefs>({
      filePath,
      validate: (value) => {
        if (typeof value !== "object" || value === null) {
          return null;
        }
        const record = value as Record<string, unknown>;
        if (record.schemaVersion !== 1) {
          return null;
        }
        const { schemaVersion: _ignored, ...rest } = record;
        return rest as TestPrefs;
      },
    });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tmpDir, "nested"), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 999, translateEnabled: false }),
      "utf8"
    );
    expect(await validated.load()).toBeNull();
  });

  it("writes human-readable pretty JSON", async () => {
    await store.save({ translateEnabled: false });
    const raw = readFileSync(filePath, "utf8");
    expect(raw).toContain("\n");
    expect(raw.trim().startsWith("{")).toBe(true);
  });

  it("clear() followed by load() returns null (matches InMemory semantics)", async () => {
    await store.save({ translateEnabled: true, reasoningMode: "on" });
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("clear() deletes the file on disk (not just empties it)", async () => {
    await store.save({ translateEnabled: true });
    expect(existsSync(filePath)).toBe(true);
    await store.clear();
    expect(existsSync(filePath)).toBe(false);
  });

  it("clear() is a no-op when the file does not exist", async () => {
    await expect(store.clear()).resolves.toBeUndefined();
    expect(existsSync(filePath)).toBe(false);
  });

  it("survives a simulated process restart (new instance, same path)", async () => {
    await store.save({
      translateEnabled: true,
      reasoningMode: "on",
      toolFallbackMode: "morphxml",
    });
    const fresh = new FilePreferencesStore<TestPrefs>({ filePath });
    expect(await fresh.load()).toEqual({
      translateEnabled: true,
      reasoningMode: "on",
      toolFallbackMode: "morphxml",
    });
  });
});

describe("LayeredPreferencesStore", () => {
  it("merges layers from low to high priority", async () => {
    const userLayer = new InMemoryPreferencesStore<TestPrefs>();
    const workspaceLayer = new InMemoryPreferencesStore<TestPrefs>();
    await userLayer.save({
      translateEnabled: true,
      reasoningMode: "off",
    });
    await workspaceLayer.save({ reasoningMode: "on" });

    const layered = new LayeredPreferencesStore<TestPrefs>({
      stores: [userLayer, workspaceLayer],
      merge: shallowMergePreferences,
    });

    expect(await layered.load()).toEqual({
      translateEnabled: true,
      reasoningMode: "on",
    });
  });

  it("returns null when all layers are empty", async () => {
    const layered = new LayeredPreferencesStore<TestPrefs>({
      stores: [
        new InMemoryPreferencesStore<TestPrefs>(),
        new InMemoryPreferencesStore<TestPrefs>(),
      ],
      merge: shallowMergePreferences,
    });
    expect(await layered.load()).toBeNull();
  });

  it("returns only user layer when workspace is empty", async () => {
    const userLayer = new InMemoryPreferencesStore<TestPrefs>();
    const workspaceLayer = new InMemoryPreferencesStore<TestPrefs>();
    await userLayer.save({ translateEnabled: false });

    const layered = new LayeredPreferencesStore<TestPrefs>({
      stores: [userLayer, workspaceLayer],
      merge: shallowMergePreferences,
    });
    expect(await layered.load()).toEqual({ translateEnabled: false });
  });

  it("writes to the workspace layer by default, not the user layer", async () => {
    const userLayer = new InMemoryPreferencesStore<TestPrefs>();
    const workspaceLayer = new InMemoryPreferencesStore<TestPrefs>();
    await userLayer.save({ translateEnabled: true });

    const layered = new LayeredPreferencesStore<TestPrefs>({
      stores: [userLayer, workspaceLayer],
      merge: shallowMergePreferences,
    });
    await layered.save({ translateEnabled: false, reasoningMode: "on" });

    expect(await userLayer.load()).toEqual({ translateEnabled: true });
    expect(await workspaceLayer.load()).toEqual({
      translateEnabled: false,
      reasoningMode: "on",
    });
  });

  it("honors an explicit writeLayerIndex", async () => {
    const userLayer = new InMemoryPreferencesStore<TestPrefs>();
    const workspaceLayer = new InMemoryPreferencesStore<TestPrefs>();
    const layered = new LayeredPreferencesStore<TestPrefs>({
      stores: [userLayer, workspaceLayer],
      merge: shallowMergePreferences,
      writeLayerIndex: 0,
    });
    await layered.save({ translateEnabled: false });
    expect(await userLayer.load()).toEqual({ translateEnabled: false });
    expect(await workspaceLayer.load()).toBeNull();
  });

  it("throws if no stores are provided", () => {
    expect(
      () =>
        new LayeredPreferencesStore<TestPrefs>({
          stores: [],
          merge: shallowMergePreferences,
        })
    ).toThrow(EMPTY_STORES_PATTERN);
  });

  it("throws if writeLayerIndex is out of range", () => {
    expect(
      () =>
        new LayeredPreferencesStore<TestPrefs>({
          stores: [new InMemoryPreferencesStore<TestPrefs>()],
          merge: shallowMergePreferences,
          writeLayerIndex: 5,
        })
    ).toThrow(WRITE_LAYER_OUT_OF_RANGE_PATTERN);
  });
});

describe("shallowMergePreferences", () => {
  it("treats undefined fields in next as no-op overrides", () => {
    const merged = shallowMergePreferences<TestPrefs>(
      { translateEnabled: true, reasoningMode: "off" },
      { translateEnabled: undefined, reasoningMode: "on" }
    );
    expect(merged).toEqual({ translateEnabled: true, reasoningMode: "on" });
  });

  it("returns accumulator when next is null", () => {
    const acc: TestPrefs = { translateEnabled: false };
    expect(shallowMergePreferences(acc, null)).toEqual(acc);
  });

  it("returns next (filtered) when accumulator is null", () => {
    expect(
      shallowMergePreferences<TestPrefs>(null, {
        translateEnabled: false,
        reasoningMode: undefined,
      })
    ).toEqual({ translateEnabled: false });
  });

  it("returns null when both inputs are null", () => {
    expect(shallowMergePreferences(null, null)).toBeNull();
  });
});

describe("createLayeredPreferences", () => {
  let tmpDir: string;
  let homeDirOverride: string;
  let cwdOverride: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "create-layered-prefs-test-"));
    homeDirOverride = join(tmpDir, "home");
    cwdOverride = join(tmpDir, "project");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses default app name and file name for the layered paths", () => {
    const { paths } = createLayeredPreferences<TestPrefs>({
      homeDir: homeDirOverride,
      cwd: cwdOverride,
    });
    expect(paths.userFilePath).toBe(
      join(
        homeDirOverride,
        `.${DEFAULT_LAYERED_PREFERENCES_APP_NAME}`,
        DEFAULT_LAYERED_PREFERENCES_FILE_NAME
      )
    );
    expect(paths.workspaceFilePath).toBe(
      join(
        cwdOverride,
        `.${DEFAULT_LAYERED_PREFERENCES_APP_NAME}`,
        DEFAULT_LAYERED_PREFERENCES_FILE_NAME
      )
    );
  });

  it("honors a custom app name and file name", () => {
    const { paths } = createLayeredPreferences<TestPrefs>({
      appName: "custom-app",
      fileName: "prefs.json",
      homeDir: homeDirOverride,
      cwd: cwdOverride,
    });
    expect(paths.userFilePath).toBe(
      join(homeDirOverride, ".custom-app", "prefs.json")
    );
    expect(paths.workspaceFilePath).toBe(
      join(cwdOverride, ".custom-app", "prefs.json")
    );
  });

  it("honors fully custom file paths", () => {
    const userFilePath = join(tmpDir, "user", "custom.json");
    const workspaceFilePath = join(tmpDir, "ws", "custom.json");
    const { paths } = createLayeredPreferences<TestPrefs>({
      userFilePath,
      workspaceFilePath,
    });
    expect(paths.userFilePath).toBe(userFilePath);
    expect(paths.workspaceFilePath).toBe(workspaceFilePath);
  });

  it("round-trips preferences through the workspace layer", async () => {
    const { store, workspaceStore } = createLayeredPreferences<TestPrefs>({
      homeDir: homeDirOverride,
      cwd: cwdOverride,
    });
    await store.save({ translateEnabled: false, reasoningMode: "on" });
    expect(await workspaceStore.load()).toEqual({
      translateEnabled: false,
      reasoningMode: "on",
    });
  });

  it("layered load merges user defaults under workspace overrides", async () => {
    const { userStore, workspaceStore, store } =
      createLayeredPreferences<TestPrefs>({
        homeDir: homeDirOverride,
        cwd: cwdOverride,
      });
    await userStore.save({
      translateEnabled: true,
      reasoningMode: "off",
    });
    await workspaceStore.save({ reasoningMode: "on" });
    expect(await store.load()).toEqual({
      translateEnabled: true,
      reasoningMode: "on",
    });
  });

  it("patch() merges a partial into the existing workspace value", async () => {
    const { workspaceStore, patch } = createLayeredPreferences<TestPrefs>({
      homeDir: homeDirOverride,
      cwd: cwdOverride,
    });
    await workspaceStore.save({
      translateEnabled: true,
      reasoningMode: "on",
    });
    const merged = await patch({ translateEnabled: false });
    expect(merged).toEqual({
      translateEnabled: false,
      reasoningMode: "on",
    });
    expect(await workspaceStore.load()).toEqual({
      translateEnabled: false,
      reasoningMode: "on",
    });
  });

  it("patch() on an empty workspace creates the file with only the patched fields", async () => {
    const { workspaceStore, patch } = createLayeredPreferences<TestPrefs>({
      homeDir: homeDirOverride,
      cwd: cwdOverride,
    });
    const merged = await patch({ translateEnabled: false });
    expect(merged).toEqual({ translateEnabled: false });
    expect(await workspaceStore.load()).toEqual({ translateEnabled: false });
  });

  it("patch() treats undefined entries as no-op fields", async () => {
    const { workspaceStore, patch } = createLayeredPreferences<TestPrefs>({
      homeDir: homeDirOverride,
      cwd: cwdOverride,
    });
    await workspaceStore.save({ translateEnabled: true });
    await patch({ translateEnabled: undefined });
    expect(await workspaceStore.load()).toEqual({ translateEnabled: true });
  });

  it("routes writes through the workspace layer, never the user layer", async () => {
    const { userStore, workspaceStore, store } =
      createLayeredPreferences<TestPrefs>({
        homeDir: homeDirOverride,
        cwd: cwdOverride,
      });
    await userStore.save({ translateEnabled: true });
    await store.save({ translateEnabled: false });
    expect(await userStore.load()).toEqual({ translateEnabled: true });
    expect(await workspaceStore.load()).toEqual({ translateEnabled: false });
  });

  it("runs the provided validator on loaded values", async () => {
    const { userStore, store } = createLayeredPreferences<TestPrefs>({
      homeDir: homeDirOverride,
      cwd: cwdOverride,
      validate: (value) => {
        if (typeof value !== "object" || value === null) {
          return null;
        }
        const record = value as Record<string, unknown>;
        if (record.reasoningMode === "bogus") {
          return null;
        }
        return record as TestPrefs;
      },
    });
    await userStore.save({
      reasoningMode: "bogus" as TestPrefs["reasoningMode"],
    });
    expect(await store.load()).toBeNull();
  });

  it("concurrent patch() calls on the same bundle never lose updates", async () => {
    const { patch, workspaceStore } = createLayeredPreferences<TestPrefs>({
      homeDir: homeDirOverride,
      cwd: cwdOverride,
    });
    await Promise.all([
      patch({ translateEnabled: false }),
      patch({ reasoningMode: "on" }),
      patch({ toolFallbackMode: "morphxml" }),
    ]);
    expect(await workspaceStore.load()).toEqual({
      translateEnabled: false,
      reasoningMode: "on",
      toolFallbackMode: "morphxml",
    });
  });

  it("concurrent patch() writes on the same key apply last-writer-wins deterministically", async () => {
    const { patch, workspaceStore } = createLayeredPreferences<TestPrefs>({
      homeDir: homeDirOverride,
      cwd: cwdOverride,
    });
    await Promise.all([
      patch({ reasoningMode: "on" }),
      patch({ reasoningMode: "off" }),
    ]);
    const result = await workspaceStore.load();
    expect(result?.reasoningMode).toBe("off");
  });

  it("patch() rejections do not poison the queue for later calls", async () => {
    const { patch, workspaceStore } = createLayeredPreferences<TestPrefs>({
      homeDir: homeDirOverride,
      cwd: cwdOverride,
    });
    const originalSave = workspaceStore.save.bind(workspaceStore);
    let shouldFailNextSave = true;
    (workspaceStore as { save: typeof workspaceStore.save }).save = (value) => {
      if (shouldFailNextSave) {
        shouldFailNextSave = false;
        return Promise.reject(new Error("simulated disk failure"));
      }
      return originalSave(value);
    };

    await expect(patch({ translateEnabled: true })).rejects.toThrow(
      SIMULATED_DISK_FAILURE_PATTERN
    );
    await patch({ translateEnabled: false });
    expect(await workspaceStore.load()).toEqual({ translateEnabled: false });
  });
});
