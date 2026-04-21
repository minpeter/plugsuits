import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLayeredPreferences,
  type LayeredPreferences,
} from "@ai-sdk-tool/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentManager } from "../agent";
import type { UserPreferences } from "../user-preferences";
import { resetPreferencesPersistenceForTesting } from "./preferences-persistence";
import { createTranslateCommand } from "./translate";

const BUNDLE_NOT_CONFIGURED_PATTERN = /preferences bundle is not configured/;

describe("translate command", () => {
  let tmpDir: string;
  let bundle: LayeredPreferences<UserPreferences>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "translate-cmd-test-"));
    bundle = createLayeredPreferences<UserPreferences>({
      userFilePath: join(tmpDir, "user", "settings.json"),
      workspaceFilePath: join(tmpDir, "ws", "settings.json"),
    });
    agentManager.resetForTesting();
    resetPreferencesPersistenceForTesting();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    resetPreferencesPersistenceForTesting();
  });

  it("reports current translation state when called without args", async () => {
    agentManager.setTranslationEnabled(true);
    const command = createTranslateCommand(bundle);

    const result = await command.execute({ args: [] });

    expect(result?.success).toBe(true);
    expect(result?.message).toContain("Translation is enabled");
  });

  it("enables translation with on/enable/true", async () => {
    const command = createTranslateCommand(bundle);

    for (const raw of ["on", "enable", "true"]) {
      agentManager.setTranslationEnabled(false);
      await bundle.workspaceStore.clear();
      const result = await command.execute({ args: [raw] });
      expect(result?.success).toBe(true);
      expect(agentManager.isTranslationEnabled()).toBe(true);
      expect(result?.message).toContain("Translation enabled");
    }
  });

  it("disables translation with off/disable/false", async () => {
    const command = createTranslateCommand(bundle);

    for (const raw of ["off", "disable", "false"]) {
      agentManager.setTranslationEnabled(true);
      await bundle.workspaceStore.clear();
      const result = await command.execute({ args: [raw] });
      expect(result?.success).toBe(true);
      expect(agentManager.isTranslationEnabled()).toBe(false);
      expect(result?.message).toContain("Translation disabled");
    }
  });

  it("rejects invalid arguments", async () => {
    const command = createTranslateCommand(bundle);
    const result = await command.execute({ args: ["maybe"] });

    expect(result?.success).toBe(false);
    expect(result?.message).toContain("Invalid argument");
    expect(result?.message).toContain("on");
    expect(result?.message).toContain("off");
  });

  it("persists the new translation state to the workspace store", async () => {
    const command = createTranslateCommand(bundle);

    const result = await command.execute({ args: ["off"] });
    expect(result?.success).toBe(true);
    expect(await bundle.workspaceStore.load()).toEqual({
      translateEnabled: false,
    });
  });

  it("does not overwrite sibling workspace fields when toggling", async () => {
    await bundle.workspaceStore.save({
      translateEnabled: true,
      reasoningMode: "on",
    });
    const command = createTranslateCommand(bundle);

    await command.execute({ args: ["off"] });

    expect(await bundle.workspaceStore.load()).toEqual({
      translateEnabled: false,
      reasoningMode: "on",
    });
  });

  it("throws when constructed without a configured bundle", () => {
    expect(() => createTranslateCommand(null)).toThrow(
      BUNDLE_NOT_CONFIGURED_PATTERN
    );
  });
});
