import { InMemoryPreferencesStore } from "@ai-sdk-tool/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentManager } from "../agent";
import { TOOL_FALLBACK_MODES } from "../tool-fallback-mode";
import type { UserPreferences } from "../user-preferences";
import {
  configurePreferencesPersistence,
  resetPreferencesPersistenceForTesting,
} from "./preferences-persistence";
import { createToolFallbackCommand } from "./tool-fallback";

const flushMicrotasks = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

describe("tool-fallback command", () => {
  const command = createToolFallbackCommand();
  let workspaceStore: InMemoryPreferencesStore<UserPreferences>;

  beforeEach(() => {
    agentManager.resetForTesting();
    resetPreferencesPersistenceForTesting();
    workspaceStore = new InMemoryPreferencesStore<UserPreferences>();
  });

  afterEach(() => {
    resetPreferencesPersistenceForTesting();
  });

  it("reports current mode when called without args", async () => {
    const result = await command.execute({ args: [] });
    expect(result?.success).toBe(true);
    expect(result?.message).toContain("Tool fallback mode:");
  });

  it("rejects invalid modes", async () => {
    const result = await command.execute({ args: ["bogus"] });
    expect(result?.success).toBe(false);
    expect(result?.message).toContain("Invalid mode");
  });

  it("persists mode changes to the configured workspace store", async () => {
    configurePreferencesPersistence({ workspaceStore });
    const current = agentManager.getToolFallbackMode();
    const target = TOOL_FALLBACK_MODES.find((mode) => mode !== current);
    if (!target) {
      return;
    }
    const result = await command.execute({ args: [target] });
    expect(result?.success).toBe(true);
    expect(agentManager.getToolFallbackMode()).toBe(target);
    await flushMicrotasks();
    await flushMicrotasks();
    const persisted = await workspaceStore.load();
    expect(persisted?.toolFallbackMode).toBe(target);
  });

  it("preserves sibling workspace fields when persisting a mode change", async () => {
    await workspaceStore.save({
      translateEnabled: false,
      reasoningMode: "on",
    });
    configurePreferencesPersistence({ workspaceStore });
    const current = agentManager.getToolFallbackMode();
    const target = TOOL_FALLBACK_MODES.find((mode) => mode !== current);
    if (!target) {
      return;
    }
    await command.execute({ args: [target] });
    await flushMicrotasks();
    await flushMicrotasks();
    const persisted = await workspaceStore.load();
    expect(persisted?.translateEnabled).toBe(false);
    expect(persisted?.reasoningMode).toBe("on");
    expect(persisted?.toolFallbackMode).toBe(target);
  });

  it("does not crash when persistence is not configured", async () => {
    const current = agentManager.getToolFallbackMode();
    const target = TOOL_FALLBACK_MODES.find((mode) => mode !== current);
    if (!target) {
      return;
    }
    const result = await command.execute({ args: [target] });
    expect(result?.success).toBe(true);
    expect(agentManager.getToolFallbackMode()).toBe(target);
  });

  it("'already using' path does not persist", async () => {
    configurePreferencesPersistence({ workspaceStore });
    const current = agentManager.getToolFallbackMode();
    const result = await command.execute({ args: [current] });
    expect(result?.success).toBe(true);
    expect(result?.message).toContain("Already");
    await flushMicrotasks();
    expect(await workspaceStore.load()).toBeNull();
  });
});
