import { InMemoryPreferencesStore } from "@ai-sdk-tool/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserPreferences } from "../user-preferences";
import {
  configurePreferencesPersistence,
  getPreferencesBundle,
  persistPreferencePatch,
  resetPreferencesPersistenceForTesting,
} from "./preferences-persistence";

const flushMicrotasks = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

describe("preferences-persistence module", () => {
  let workspaceStore: InMemoryPreferencesStore<UserPreferences>;

  beforeEach(() => {
    resetPreferencesPersistenceForTesting();
    workspaceStore = new InMemoryPreferencesStore<UserPreferences>();
  });

  afterEach(() => {
    resetPreferencesPersistenceForTesting();
  });

  it("getPreferencesBundle returns null before configuration", () => {
    expect(getPreferencesBundle()).toBeNull();
  });

  it("getPreferencesBundle returns the configured bundle", () => {
    const bundle = {
      paths: { userFilePath: "x", workspaceFilePath: "y" },
      store: workspaceStore,
      userStore: new InMemoryPreferencesStore<UserPreferences>(),
      workspaceStore,
      patch: async () => ({}) as UserPreferences,
    };
    configurePreferencesPersistence({ bundle, workspaceStore });
    expect(getPreferencesBundle()).toBe(bundle);
  });

  it("persistPreferencePatch is a no-op when persistence is not configured", async () => {
    persistPreferencePatch({ translateEnabled: false });
    await flushMicrotasks();
    expect(await workspaceStore.load()).toBeNull();
  });

  it("persistPreferencePatch writes to the configured workspace store", async () => {
    configurePreferencesPersistence({ workspaceStore });
    persistPreferencePatch({ translateEnabled: false });
    await flushMicrotasks();
    expect(await workspaceStore.load()).toEqual({ translateEnabled: false });
  });

  it("persistPreferencePatch invokes custom onError handler when save fails", async () => {
    (workspaceStore as { save: typeof workspaceStore.save }).save = () =>
      Promise.reject(new Error("simulated disk failure"));
    const capturedErrors: unknown[] = [];
    configurePreferencesPersistence({
      workspaceStore,
      onError: (error) => capturedErrors.push(error),
    });
    persistPreferencePatch({ translateEnabled: false });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(capturedErrors).toHaveLength(1);
    expect((capturedErrors[0] as Error).message).toBe("simulated disk failure");
  });

  it("resetPreferencesPersistenceForTesting clears both the bundle and the store", () => {
    configurePreferencesPersistence({ workspaceStore });
    resetPreferencesPersistenceForTesting();
    expect(getPreferencesBundle()).toBeNull();
  });

  it("concurrent persistPreferencePatch calls on different fields preserve all of them", async () => {
    configurePreferencesPersistence({ workspaceStore });
    persistPreferencePatch({ translateEnabled: false });
    persistPreferencePatch({ reasoningMode: "on" });
    persistPreferencePatch({ toolFallbackMode: "morphxml" });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(await workspaceStore.load()).toEqual({
      translateEnabled: false,
      reasoningMode: "on",
      toolFallbackMode: "morphxml",
    });
  });
});
