import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createUserPreferencesStore,
  patchWorkspacePreferences,
  withStoredSchemaVersion,
} from "./user-preferences";

const SIMULATED_DISK_ERROR_PATTERN = /simulated disk error/;

describe("user-preferences", () => {
  let tmpDir: string;
  let userFilePath: string;
  let workspaceFilePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cea-user-prefs-test-"));
    userFilePath = join(tmpDir, "user", "settings.json");
    workspaceFilePath = join(tmpDir, "workspace", "settings.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no layer has anything", async () => {
    const { store } = createUserPreferencesStore({
      userFilePath,
      workspaceFilePath,
    });
    expect(await store.load()).toBeNull();
  });

  it("workspace layer overrides user layer on conflict", async () => {
    await mkdir(dirname(userFilePath), { recursive: true });
    writeFileSync(
      userFilePath,
      JSON.stringify(
        withStoredSchemaVersion({
          translateEnabled: true,
          reasoningMode: "off",
        })
      ),
      "utf8"
    );
    await mkdir(dirname(workspaceFilePath), { recursive: true });
    writeFileSync(
      workspaceFilePath,
      JSON.stringify(withStoredSchemaVersion({ reasoningMode: "on" })),
      "utf8"
    );

    const { store } = createUserPreferencesStore({
      userFilePath,
      workspaceFilePath,
    });
    expect(await store.load()).toEqual({
      translateEnabled: true,
      reasoningMode: "on",
    });
  });

  it("returns only user-layer fields when workspace is absent", async () => {
    await mkdir(dirname(userFilePath), { recursive: true });
    writeFileSync(
      userFilePath,
      JSON.stringify(withStoredSchemaVersion({ translateEnabled: false })),
      "utf8"
    );
    const { store } = createUserPreferencesStore({
      userFilePath,
      workspaceFilePath,
    });
    expect(await store.load()).toEqual({ translateEnabled: false });
  });

  it("ignores malformed enum values in stored files", async () => {
    await mkdir(dirname(workspaceFilePath), { recursive: true });
    writeFileSync(
      workspaceFilePath,
      JSON.stringify({
        schemaVersion: 1,
        reasoningMode: "not-a-mode",
        translateEnabled: false,
      }),
      "utf8"
    );
    const { store } = createUserPreferencesStore({
      userFilePath,
      workspaceFilePath,
    });
    expect(await store.load()).toBeNull();
  });

  it("ignores malformed JSON entirely", async () => {
    await mkdir(dirname(workspaceFilePath), { recursive: true });
    writeFileSync(workspaceFilePath, "{not json", "utf8");
    const { store } = createUserPreferencesStore({
      userFilePath,
      workspaceFilePath,
    });
    expect(await store.load()).toBeNull();
  });

  it("saves to workspace layer only", async () => {
    const { store, workspaceStore } = createUserPreferencesStore({
      userFilePath,
      workspaceFilePath,
    });
    await store.save({ translateEnabled: false });
    expect(await workspaceStore.load()).toEqual({ translateEnabled: false });
  });

  it("patchWorkspacePreferences merges new fields without clobbering existing ones", async () => {
    const { workspaceStore } = createUserPreferencesStore({
      userFilePath,
      workspaceFilePath,
    });
    await workspaceStore.save({
      translateEnabled: true,
      reasoningMode: "on",
    });
    const merged = await patchWorkspacePreferences(workspaceStore, {
      translateEnabled: false,
    });
    expect(merged).toEqual({
      translateEnabled: false,
      reasoningMode: "on",
    });
    expect(await workspaceStore.load()).toEqual({
      translateEnabled: false,
      reasoningMode: "on",
    });
  });

  it("patchWorkspacePreferences treats undefined as no-op", async () => {
    const { workspaceStore } = createUserPreferencesStore({
      userFilePath,
      workspaceFilePath,
    });
    await workspaceStore.save({ translateEnabled: true });
    await patchWorkspacePreferences(workspaceStore, {
      translateEnabled: undefined,
    });
    expect(await workspaceStore.load()).toEqual({ translateEnabled: true });
  });

  it("round-trips all three tracked fields", async () => {
    const { store, workspaceStore } = createUserPreferencesStore({
      userFilePath,
      workspaceFilePath,
    });
    await store.save({
      translateEnabled: false,
      reasoningMode: "interleaved",
      toolFallbackMode: "morphxml",
    });
    expect(await workspaceStore.load()).toEqual({
      translateEnabled: false,
      reasoningMode: "interleaved",
      toolFallbackMode: "morphxml",
    });
    expect(await store.load()).toEqual({
      translateEnabled: false,
      reasoningMode: "interleaved",
      toolFallbackMode: "morphxml",
    });
  });

  it("concurrent patchWorkspacePreferences on different fields does not lose updates", async () => {
    const { workspaceStore } = createUserPreferencesStore({
      userFilePath,
      workspaceFilePath,
    });
    await Promise.all([
      patchWorkspacePreferences(workspaceStore, { translateEnabled: false }),
      patchWorkspacePreferences(workspaceStore, { reasoningMode: "on" }),
      patchWorkspacePreferences(workspaceStore, {
        toolFallbackMode: "morphxml",
      }),
    ]);
    expect(await workspaceStore.load()).toEqual({
      translateEnabled: false,
      reasoningMode: "on",
      toolFallbackMode: "morphxml",
    });
  });

  it("concurrent patchWorkspacePreferences on the same field is last-writer-wins deterministically", async () => {
    const { workspaceStore } = createUserPreferencesStore({
      userFilePath,
      workspaceFilePath,
    });
    await Promise.all([
      patchWorkspacePreferences(workspaceStore, { reasoningMode: "off" }),
      patchWorkspacePreferences(workspaceStore, { reasoningMode: "on" }),
    ]);
    const final = await workspaceStore.load();
    expect(final?.reasoningMode).toBe("on");
  });

  it("patchWorkspacePreferences surfaces save errors to the caller", async () => {
    const { workspaceStore } = createUserPreferencesStore({
      userFilePath,
      workspaceFilePath,
    });
    const originalSave = workspaceStore.save.bind(workspaceStore);
    (workspaceStore as { save: typeof workspaceStore.save }).save = () =>
      Promise.reject(new Error("simulated disk error"));
    await expect(
      patchWorkspacePreferences(workspaceStore, { translateEnabled: false })
    ).rejects.toThrow(SIMULATED_DISK_ERROR_PATTERN);
    (workspaceStore as { save: typeof workspaceStore.save }).save =
      originalSave;
    await patchWorkspacePreferences(workspaceStore, {
      translateEnabled: false,
    });
    expect(await workspaceStore.load()).toEqual({ translateEnabled: false });
  });
});
