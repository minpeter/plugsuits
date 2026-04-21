import { beforeEach, describe, expect, it } from "vitest";
import {
  createEnumPreferenceCommand,
  createTogglePreferenceCommand,
} from "./preference-commands";
import {
  InMemoryPreferencesStore,
  type LayeredPreferences,
  shallowMergePreferences,
} from "./preferences-store";

interface TogglePrefs {
  enabled?: boolean;
}

interface EnumPrefs {
  mode?: "off" | "on" | "auto";
}

const inMemoryLayered = <T extends object>(): LayeredPreferences<T> => {
  const userStore = new InMemoryPreferencesStore<T>();
  const workspaceStore = new InMemoryPreferencesStore<T>();
  return {
    paths: { userFilePath: "<memory-user>", workspaceFilePath: "<memory-ws>" },
    store: {
      load: async () => {
        const user = await userStore.load();
        const workspace = await workspaceStore.load();
        return shallowMergePreferences(user, workspace);
      },
      save: (value) => workspaceStore.save(value),
      clear: () => workspaceStore.clear(),
    },
    userStore,
    workspaceStore,
    patch: async (partial) => {
      const existing = (await workspaceStore.load()) ?? ({} as T);
      const merged: T = { ...(existing as object) } as T;
      for (const [key, value] of Object.entries(partial as object)) {
        if (value !== undefined) {
          (merged as Record<string, unknown>)[key] = value;
        }
      }
      await workspaceStore.save(merged);
      return merged;
    },
  };
};

describe("createTogglePreferenceCommand", () => {
  let preferences: LayeredPreferences<TogglePrefs>;
  let runtime: { enabled: boolean };

  beforeEach(() => {
    preferences = inMemoryLayered<TogglePrefs>();
    runtime = { enabled: false };
  });

  const makeCommand = () =>
    createTogglePreferenceCommand<TogglePrefs, "enabled">({
      name: "feature",
      preferences,
      field: "enabled",
      get: () => runtime.enabled,
      set: (next) => {
        runtime.enabled = next;
      },
    });

  it("reports current runtime state when called without args", async () => {
    runtime.enabled = true;
    const result = await makeCommand().execute({ args: [] });
    expect(result.success).toBe(true);
    expect(result.message).toContain("Feature is enabled");
  });

  it("enables on 'on', 'enable', 'true'", async () => {
    const command = makeCommand();
    for (const raw of ["on", "enable", "true", "ENABLE"]) {
      runtime.enabled = false;
      await preferences.workspaceStore.clear();
      const result = await command.execute({ args: [raw] });
      expect(result.success).toBe(true);
      expect(runtime.enabled).toBe(true);
      expect(await preferences.workspaceStore.load()).toEqual({
        enabled: true,
      });
    }
  });

  it("disables on 'off', 'disable', 'false'", async () => {
    const command = makeCommand();
    for (const raw of ["off", "disable", "false"]) {
      runtime.enabled = true;
      await preferences.workspaceStore.clear();
      const result = await command.execute({ args: [raw] });
      expect(result.success).toBe(true);
      expect(runtime.enabled).toBe(false);
      expect(await preferences.workspaceStore.load()).toEqual({
        enabled: false,
      });
    }
  });

  it("rejects invalid arguments", async () => {
    const result = await makeCommand().execute({ args: ["maybe"] });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid argument");
  });

  it("honors custom truthy/falsy lists", async () => {
    const command = createTogglePreferenceCommand<TogglePrefs, "enabled">({
      name: "feature",
      preferences,
      field: "enabled",
      get: () => runtime.enabled,
      set: (next) => {
        runtime.enabled = next;
      },
      truthyValues: ["yes"],
      falsyValues: ["no"],
    });
    const ok = await command.execute({ args: ["yes"] });
    expect(ok.success).toBe(true);
    expect(runtime.enabled).toBe(true);
    const rejected = await command.execute({ args: ["on"] });
    expect(rejected.success).toBe(false);
  });

  it("uses the configured feature name and messages", async () => {
    const command = createTogglePreferenceCommand<TogglePrefs, "enabled">({
      name: "feature",
      preferences,
      field: "enabled",
      featureName: "Translation",
      enabledMessage: "Translation is now ON",
      disabledMessage: "Translation is now OFF",
      get: () => runtime.enabled,
      set: (next) => {
        runtime.enabled = next;
      },
    });
    const enabled = await command.execute({ args: ["on"] });
    expect(enabled.message).toBe("Translation is now ON");
    const disabled = await command.execute({ args: ["off"] });
    expect(disabled.message).toBe("Translation is now OFF");
    const current = await command.execute({ args: [] });
    expect(current.message).toContain("Translation is");
  });

  it("does not overwrite sibling preference fields when patching", async () => {
    interface MultiPrefs extends Record<string, unknown> {
      enabled?: boolean;
      other?: string;
    }
    const multi = inMemoryLayered<MultiPrefs>();
    await multi.workspaceStore.save({ other: "keep-me" });
    const multiRuntime = { enabled: false };

    const command = createTogglePreferenceCommand<MultiPrefs, "enabled">({
      name: "feature",
      preferences: multi,
      field: "enabled",
      get: () => multiRuntime.enabled,
      set: (next) => {
        multiRuntime.enabled = next;
      },
    });
    await command.execute({ args: ["on"] });
    expect(await multi.workspaceStore.load()).toEqual({
      other: "keep-me",
      enabled: true,
    });
  });

  it("awaits async setters before persisting", async () => {
    const events: string[] = [];
    const command = createTogglePreferenceCommand<TogglePrefs, "enabled">({
      name: "feature",
      preferences,
      field: "enabled",
      get: () => runtime.enabled,
      set: async (next) => {
        await new Promise((resolve) => setImmediate(resolve));
        events.push(`set:${next}`);
        runtime.enabled = next;
      },
    });
    await command.execute({ args: ["on"] });
    events.push("persisted");
    expect(events).toEqual(["set:true", "persisted"]);
  });
});

describe("createEnumPreferenceCommand", () => {
  let preferences: LayeredPreferences<EnumPrefs>;
  let runtime: { mode: "off" | "on" | "auto" };

  beforeEach(() => {
    preferences = inMemoryLayered<EnumPrefs>();
    runtime = { mode: "off" };
  });

  const makeCommand = () =>
    createEnumPreferenceCommand<EnumPrefs, "mode", "off" | "on" | "auto">({
      name: "mode",
      preferences,
      field: "mode",
      values: ["off", "on", "auto"],
      get: () => runtime.mode,
      set: (next) => {
        runtime.mode = next;
      },
    });

  it("reports current state when called without args", async () => {
    runtime.mode = "auto";
    const result = await makeCommand().execute({ args: [] });
    expect(result.success).toBe(true);
    expect(result.message).toContain("Mode: auto");
    expect(result.message).toContain("off|on|auto");
  });

  it("accepts each listed value case-insensitively", async () => {
    const command = makeCommand();
    for (const raw of ["on", "ON", "Auto"]) {
      await command.execute({ args: [raw] });
      expect(["on", "auto"]).toContain(runtime.mode);
    }
  });

  it("rejects values outside the enum", async () => {
    const result = await makeCommand().execute({ args: ["bogus"] });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid value");
  });

  it("uses a custom parser when provided", async () => {
    const command = createEnumPreferenceCommand<
      EnumPrefs,
      "mode",
      "off" | "on" | "auto"
    >({
      name: "mode",
      preferences,
      field: "mode",
      values: ["off", "on", "auto"],
      get: () => runtime.mode,
      set: (next) => {
        runtime.mode = next;
      },
      parse: (raw) => {
        if (raw === "enable") {
          return "on";
        }
        return null;
      },
    });
    const ok = await command.execute({ args: ["enable"] });
    expect(ok.success).toBe(true);
    expect(runtime.mode).toBe("on");
    const rejected = await command.execute({ args: ["on"] });
    expect(rejected.success).toBe(false);
  });

  it("runs validate() and surfaces its message on failure", async () => {
    const command = createEnumPreferenceCommand<
      EnumPrefs,
      "mode",
      "off" | "on" | "auto"
    >({
      name: "mode",
      preferences,
      field: "mode",
      values: ["off", "on", "auto"],
      get: () => runtime.mode,
      set: (next) => {
        runtime.mode = next;
      },
      validate: (next) =>
        next === "auto"
          ? { ok: false, message: "auto is not supported right now" }
          : { ok: true },
    });
    const rejected = await command.execute({ args: ["auto"] });
    expect(rejected.success).toBe(false);
    expect(rejected.message).toBe("auto is not supported right now");
    expect(runtime.mode).toBe("off");
  });

  it("returns a no-op success when the value is already set", async () => {
    runtime.mode = "on";
    const result = await makeCommand().execute({ args: ["on"] });
    expect(result.success).toBe(true);
    expect(result.message).toContain("Already set");
    expect(await preferences.workspaceStore.load()).toBeNull();
  });

  it("persists the new value to the workspace layer", async () => {
    await makeCommand().execute({ args: ["auto"] });
    expect(runtime.mode).toBe("auto");
    expect(await preferences.workspaceStore.load()).toEqual({ mode: "auto" });
  });
});

describe("preference command persist-first contract", () => {
  const makeBundleWithFailingPatch = <T extends object>(
    failure: Error
  ): LayeredPreferences<T> => {
    const workspaceStore = new InMemoryPreferencesStore<T>();
    return {
      paths: {
        userFilePath: "<memory-user>",
        workspaceFilePath: "<memory-ws>",
      },
      store: workspaceStore,
      userStore: new InMemoryPreferencesStore<T>(),
      workspaceStore,
      patch: () => Promise.reject(failure),
    };
  };

  it("toggle: runtime is NOT mutated when persistence fails", async () => {
    const bundle = makeBundleWithFailingPatch<TogglePrefs>(
      new Error("disk full")
    );
    const runtime = { enabled: false };
    const command = createTogglePreferenceCommand<TogglePrefs, "enabled">({
      name: "feature",
      preferences: bundle,
      field: "enabled",
      get: () => runtime.enabled,
      set: (next) => {
        runtime.enabled = next;
      },
    });
    const result = await command.execute({ args: ["on"] });
    expect(result.success).toBe(false);
    expect(result.message).toContain("disk full");
    expect(runtime.enabled).toBe(false);
  });

  it("enum: runtime is NOT mutated when persistence fails", async () => {
    const bundle = makeBundleWithFailingPatch<EnumPrefs>(
      new Error("disk full")
    );
    const runtime = { mode: "off" as "off" | "on" | "auto" };
    const command = createEnumPreferenceCommand<
      EnumPrefs,
      "mode",
      "off" | "on" | "auto"
    >({
      name: "mode",
      preferences: bundle,
      field: "mode",
      values: ["off", "on", "auto"],
      get: () => runtime.mode,
      set: (next) => {
        runtime.mode = next;
      },
    });
    const result = await command.execute({ args: ["on"] });
    expect(result.success).toBe(false);
    expect(result.message).toContain("disk full");
    expect(runtime.mode).toBe("off");
  });

  it("toggle: disk is rolled back when runtime set() throws after persist", async () => {
    const workspaceStore = new InMemoryPreferencesStore<TogglePrefs>();
    await workspaceStore.save({ enabled: true });
    const patchCalls: Partial<TogglePrefs>[] = [];
    const bundle: LayeredPreferences<TogglePrefs> = {
      paths: {
        userFilePath: "<memory-user>",
        workspaceFilePath: "<memory-ws>",
      },
      store: workspaceStore,
      userStore: new InMemoryPreferencesStore<TogglePrefs>(),
      workspaceStore,
      patch: async (partial) => {
        patchCalls.push(partial);
        const existing = (await workspaceStore.load()) ?? {};
        const merged = { ...existing, ...partial };
        await workspaceStore.save(merged);
        return merged;
      },
    };

    const runtime = { enabled: true };
    const command = createTogglePreferenceCommand<TogglePrefs, "enabled">({
      name: "feature",
      preferences: bundle,
      field: "enabled",
      get: () => runtime.enabled,
      set: () => {
        throw new Error("runtime refused");
      },
    });
    const result = await command.execute({ args: ["off"] });
    expect(result.success).toBe(false);
    expect(result.message).toContain("runtime refused");
    expect(patchCalls).toEqual([{ enabled: false }, { enabled: true }]);
    expect((await workspaceStore.load())?.enabled).toBe(true);
    expect(runtime.enabled).toBe(true);
  });

  it("toggle: command execute() returns success only when disk AND runtime both succeed", async () => {
    const workspaceStore = new InMemoryPreferencesStore<TogglePrefs>();
    const bundle: LayeredPreferences<TogglePrefs> = {
      paths: {
        userFilePath: "<memory-user>",
        workspaceFilePath: "<memory-ws>",
      },
      store: workspaceStore,
      userStore: new InMemoryPreferencesStore<TogglePrefs>(),
      workspaceStore,
      patch: async (partial) => {
        const existing = (await workspaceStore.load()) ?? {};
        const merged = { ...existing, ...partial };
        await workspaceStore.save(merged);
        return merged;
      },
    };
    const runtime = { enabled: false };
    const command = createTogglePreferenceCommand<TogglePrefs, "enabled">({
      name: "feature",
      preferences: bundle,
      field: "enabled",
      get: () => runtime.enabled,
      set: (next) => {
        runtime.enabled = next;
      },
    });
    const result = await command.execute({ args: ["on"] });
    expect(result.success).toBe(true);
    expect(runtime.enabled).toBe(true);
    expect((await workspaceStore.load())?.enabled).toBe(true);
  });
});
