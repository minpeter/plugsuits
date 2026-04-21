import { InMemoryPreferencesStore } from "@ai-sdk-tool/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentManager } from "../agent";
import { resolveSharedConfig, type SharedArgs } from "../cli-defs";
import type { UserPreferences } from "../user-preferences";
import {
  applyPersistedPreferencesToAgentManager,
  applySharedConfigToAgentManager,
} from "./preferences-startup";

describe("preferences-startup wiring", () => {
  let store: InMemoryPreferencesStore<UserPreferences>;

  beforeEach(() => {
    agentManager.resetForTesting();
    store = new InMemoryPreferencesStore<UserPreferences>();
  });

  afterEach(() => {
    agentManager.resetForTesting();
  });

  describe("applyPersistedPreferencesToAgentManager", () => {
    it("applies persisted translateEnabled to the AgentManager", async () => {
      await store.save({ translateEnabled: false });
      await applyPersistedPreferencesToAgentManager(agentManager, store);
      expect(agentManager.isTranslationEnabled()).toBe(false);
    });

    it("applies persisted reasoningMode when in selectable modes", async () => {
      const selectable = agentManager.getSelectableReasoningModes();
      const current = agentManager.getReasoningMode();
      const target = selectable.find((mode) => mode !== current);
      if (!target) {
        return;
      }
      await store.save({ reasoningMode: target });
      await applyPersistedPreferencesToAgentManager(agentManager, store);
      expect(agentManager.getReasoningMode()).toBe(target);
    });

    it("applies persisted toolFallbackMode", async () => {
      await store.save({ toolFallbackMode: "morphxml" });
      await applyPersistedPreferencesToAgentManager(agentManager, store);
      expect(agentManager.getToolFallbackMode()).toBe("morphxml");
    });

    it("applies all three fields in one call", async () => {
      await store.save({
        translateEnabled: false,
        reasoningMode: agentManager.getSelectableReasoningModes()[0],
        toolFallbackMode: "morphxml",
      });
      await applyPersistedPreferencesToAgentManager(agentManager, store);
      expect(agentManager.isTranslationEnabled()).toBe(false);
      expect(agentManager.getToolFallbackMode()).toBe("morphxml");
    });

    it("leaves AgentManager state unchanged when the store is empty", async () => {
      const before = {
        translate: agentManager.isTranslationEnabled(),
        reasoning: agentManager.getReasoningMode(),
        toolFallback: agentManager.getToolFallbackMode(),
      };
      await applyPersistedPreferencesToAgentManager(agentManager, store);
      expect(agentManager.isTranslationEnabled()).toBe(before.translate);
      expect(agentManager.getReasoningMode()).toBe(before.reasoning);
      expect(agentManager.getToolFallbackMode()).toBe(before.toolFallback);
    });

    it("survives a load() rejection and reports via onLoadError", async () => {
      const failingStore: InMemoryPreferencesStore<UserPreferences> =
        new InMemoryPreferencesStore<UserPreferences>();
      (failingStore as { load: typeof failingStore.load }).load = () =>
        Promise.reject(new Error("simulated EACCES"));
      const errors: unknown[] = [];
      await applyPersistedPreferencesToAgentManager(
        agentManager,
        failingStore,
        (error) => errors.push(error)
      );
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe("simulated EACCES");
    });
  });

  describe("applySharedConfigToAgentManager (CLI precedence)", () => {
    it("CLI --no-translate overrides a persisted translateEnabled:true", async () => {
      await store.save({ translateEnabled: true });
      await applyPersistedPreferencesToAgentManager(agentManager, store);
      expect(agentManager.isTranslationEnabled()).toBe(true);

      const config = resolveSharedConfig({ translate: false } as SharedArgs, {
        rawArgs: ["--no-translate"],
      });
      applySharedConfigToAgentManager(agentManager, config);
      expect(agentManager.isTranslationEnabled()).toBe(false);
    });

    it("absence of a translate CLI flag does NOT overwrite persisted translateEnabled", async () => {
      await store.save({ translateEnabled: false });
      await applyPersistedPreferencesToAgentManager(agentManager, store);

      const config = resolveSharedConfig({} as SharedArgs, { rawArgs: [] });
      applySharedConfigToAgentManager(agentManager, config);
      expect(agentManager.isTranslationEnabled()).toBe(false);
    });

    it("CLI --reasoning-mode overrides a persisted value", async () => {
      const selectable = agentManager.getSelectableReasoningModes();
      if (selectable.length < 2) {
        return;
      }
      await store.save({ reasoningMode: selectable[0] });
      await applyPersistedPreferencesToAgentManager(agentManager, store);
      expect(agentManager.getReasoningMode()).toBe(selectable[0]);

      const config = resolveSharedConfig(
        { "reasoning-mode": selectable[1] } as SharedArgs,
        { rawArgs: ["--reasoning-mode", selectable[1]] }
      );
      applySharedConfigToAgentManager(agentManager, config);
      expect(agentManager.getReasoningMode()).toBe(selectable[1]);
    });

    it("absence of --reasoning-mode does NOT overwrite persisted value", async () => {
      const selectable = agentManager.getSelectableReasoningModes();
      const target = selectable.find(
        (mode) => mode !== agentManager.getReasoningMode()
      );
      if (!target) {
        return;
      }
      await store.save({ reasoningMode: target });
      await applyPersistedPreferencesToAgentManager(agentManager, store);

      const config = resolveSharedConfig({} as SharedArgs, { rawArgs: [] });
      applySharedConfigToAgentManager(agentManager, config);
      expect(agentManager.getReasoningMode()).toBe(target);
    });

    it("CLI --toolcall-mode overrides a persisted toolFallbackMode", async () => {
      await store.save({ toolFallbackMode: "disable" });
      await applyPersistedPreferencesToAgentManager(agentManager, store);
      expect(agentManager.getToolFallbackMode()).toBe("disable");

      const config = resolveSharedConfig(
        { "toolcall-mode": "morphxml" } as SharedArgs,
        { rawArgs: ["--toolcall-mode", "morphxml"] }
      );
      applySharedConfigToAgentManager(agentManager, config);
      expect(agentManager.getToolFallbackMode()).toBe("morphxml");
    });

    it("absence of --toolcall-mode does NOT overwrite persisted toolFallbackMode", async () => {
      await store.save({ toolFallbackMode: "morphxml" });
      await applyPersistedPreferencesToAgentManager(agentManager, store);

      const config = resolveSharedConfig({} as SharedArgs, { rawArgs: [] });
      applySharedConfigToAgentManager(agentManager, config);
      expect(agentManager.getToolFallbackMode()).toBe("morphxml");
    });

    it("applySharedConfigToAgentManager never writes to the store (CLI is one-shot)", async () => {
      await store.save({ translateEnabled: true });
      await applyPersistedPreferencesToAgentManager(agentManager, store);

      const config = resolveSharedConfig({ translate: false } as SharedArgs, {
        rawArgs: ["--no-translate"],
      });
      applySharedConfigToAgentManager(agentManager, config);

      expect(await store.load()).toEqual({ translateEnabled: true });
    });
  });
});
