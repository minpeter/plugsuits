import { InMemoryPreferencesStore } from "@ai-sdk-tool/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentManager } from "../agent";
import type { UserPreferences } from "../user-preferences";
import {
  configurePreferencesPersistence,
  resetPreferencesPersistenceForTesting,
} from "./preferences-persistence";
import { createReasoningModeCommand } from "./reasoning-mode";

const flushMicrotasks = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

describe("reasoning-mode command", () => {
  const command = createReasoningModeCommand();
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
    expect(result?.message).toContain("Reasoning mode:");
  });

  it("accepts a valid selectable mode and mutates runtime state", async () => {
    const current = agentManager.getReasoningMode();
    const selectable = agentManager.getSelectableReasoningModes();
    const target = selectable.find((mode) => mode !== current);
    if (!target) {
      return;
    }
    const result = await command.execute({ args: [target] });
    expect(result?.success).toBe(true);
    expect(agentManager.getReasoningMode()).toBe(target);
  });

  it("rejects invalid modes", async () => {
    const result = await command.execute({ args: ["bogus"] });
    expect(result?.success).toBe(false);
    expect(result?.message).toContain("Invalid mode");
  });

  it("persists mode changes to the configured workspace store", async () => {
    configurePreferencesPersistence({ workspaceStore });
    const selectable = agentManager.getSelectableReasoningModes();
    const current = agentManager.getReasoningMode();
    const target = selectable.find((mode) => mode !== current);
    if (!target) {
      return;
    }
    await command.execute({ args: [target] });
    await flushMicrotasks();
    await flushMicrotasks();
    const persisted = await workspaceStore.load();
    expect(persisted?.reasoningMode).toBe(target);
  });

  it("preserves sibling workspace fields when persisting a mode change", async () => {
    await workspaceStore.save({
      translateEnabled: false,
      toolFallbackMode: "morphxml",
    });
    configurePreferencesPersistence({ workspaceStore });
    const selectable = agentManager.getSelectableReasoningModes();
    const current = agentManager.getReasoningMode();
    const target = selectable.find((mode) => mode !== current);
    if (!target) {
      return;
    }
    await command.execute({ args: [target] });
    await flushMicrotasks();
    await flushMicrotasks();
    const persisted = await workspaceStore.load();
    expect(persisted?.translateEnabled).toBe(false);
    expect(persisted?.toolFallbackMode).toBe("morphxml");
    expect(persisted?.reasoningMode).toBe(target);
  });

  it("does not crash when persistence is not configured", async () => {
    const selectable = agentManager.getSelectableReasoningModes();
    const current = agentManager.getReasoningMode();
    const target = selectable.find((mode) => mode !== current);
    if (!target) {
      return;
    }
    const result = await command.execute({ args: [target] });
    expect(result?.success).toBe(true);
    expect(agentManager.getReasoningMode()).toBe(target);
  });

  it("'already using' path does not persist", async () => {
    configurePreferencesPersistence({ workspaceStore });
    const current = agentManager.getReasoningMode();
    const result = await command.execute({ args: [current] });
    expect(result?.success).toBe(true);
    expect(result?.message).toContain("Already");
    await flushMicrotasks();
    expect(await workspaceStore.load()).toBeNull();
  });
});
