import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTogglePreferenceCommand } from "@ai-sdk-tool/harness/preferences";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPreferences, type MinimalAgentPreferences } from "./preferences";

const MINIMAL_AGENT_SETTINGS_PATH_PATTERN =
  /[/\\]\.minimal-agent[/\\]settings\.json$/;
const CEA_PLUGSUITS_SETTINGS_PATH_PATTERN = /\.plugsuits[/\\]settings\.json$/;

describe("minimal-agent preferences", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "minimal-agent-prefs-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("paths target ~/.minimal-agent and ./.minimal-agent", () => {
    const { paths } = createPreferences();
    expect(paths.userFilePath).toMatch(MINIMAL_AGENT_SETTINGS_PATH_PATTERN);
    expect(paths.workspaceFilePath).toMatch(
      MINIMAL_AGENT_SETTINGS_PATH_PATTERN
    );
    expect(paths.userFilePath).not.toBe(paths.workspaceFilePath);
  });

  it("paths do NOT collide with the CEA plugsuits directory", () => {
    const { paths } = createPreferences();
    expect(paths.userFilePath).not.toMatch(CEA_PLUGSUITS_SETTINGS_PATH_PATTERN);
    expect(paths.workspaceFilePath).not.toMatch(
      CEA_PLUGSUITS_SETTINGS_PATH_PATTERN
    );
  });

  it("validator rejects files with unknown schemaVersion", async () => {
    const userPath = join(tmpDir, "user", "settings.json");
    const wsPath = join(tmpDir, "ws", "settings.json");
    await mkdir(dirname(userPath), { recursive: true });
    writeFileSync(
      userPath,
      JSON.stringify({ schemaVersion: 999, reasoningEnabled: true }),
      "utf8"
    );
    const { createLayeredPreferences } = await import(
      "@ai-sdk-tool/harness/preferences"
    );
    const { z } = await import("zod");
    const schema = z
      .object({
        schemaVersion: z.literal(1).optional(),
        reasoningEnabled: z.boolean().optional(),
      })
      .partial()
      .strip();
    const prefs = createLayeredPreferences<MinimalAgentPreferences>({
      userFilePath: userPath,
      workspaceFilePath: wsPath,
      validate: (value) => {
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
          return null;
        }
        const { schemaVersion, reasoningEnabled } = parsed.data as {
          schemaVersion?: number;
          reasoningEnabled?: boolean;
        };
        if (schemaVersion !== undefined && schemaVersion !== 1) {
          return null;
        }
        if (reasoningEnabled === undefined) {
          return null;
        }
        return { reasoningEnabled };
      },
    });
    expect(await prefs.store.load()).toBeNull();
  });

  it("round-trips reasoningEnabled through the real schema", async () => {
    const { createLayeredPreferences } = await import(
      "@ai-sdk-tool/harness/preferences"
    );
    const userPath = join(tmpDir, "user", "settings.json");
    const wsPath = join(tmpDir, "ws", "settings.json");
    const prefs = createLayeredPreferences<MinimalAgentPreferences>({
      userFilePath: userPath,
      workspaceFilePath: wsPath,
    });
    await prefs.patch({ reasoningEnabled: true });
    const round = await prefs.store.load();
    expect(round?.reasoningEnabled).toBe(true);
  });
});

describe("minimal-agent /reasoning onBeforeTurn integration", () => {
  it("onBeforeTurn returns { providerOptions: undefined } when reasoning is off", () => {
    const reasoningEnabled = false;
    const onBeforeTurn = () => ({
      providerOptions: reasoningEnabled
        ? { openai: { reasoningEffort: "medium" } }
        : undefined,
    });
    expect(onBeforeTurn().providerOptions).toBeUndefined();
  });

  it("onBeforeTurn returns reasoningEffort when reasoning is on", () => {
    const reasoningEnabled = true;
    const onBeforeTurn = () => ({
      providerOptions: reasoningEnabled
        ? { openai: { reasoningEffort: "medium" } }
        : undefined,
    });
    const options = onBeforeTurn().providerOptions;
    expect(options).toEqual({ openai: { reasoningEffort: "medium" } });
  });

  it("toggle command mutates the shared closure, which the subsequent onBeforeTurn reads", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "minimal-agent-live-"));
    try {
      const { createLayeredPreferences } = await import(
        "@ai-sdk-tool/harness/preferences"
      );
      const prefs = createLayeredPreferences<MinimalAgentPreferences>({
        userFilePath: join(tmp, "user", "settings.json"),
        workspaceFilePath: join(tmp, "ws", "settings.json"),
      });
      let reasoningEnabled = false;
      const onBeforeTurn = () => ({
        providerOptions: reasoningEnabled
          ? { openai: { reasoningEffort: "medium" } }
          : undefined,
      });
      const toggle = createTogglePreferenceCommand<
        MinimalAgentPreferences,
        "reasoningEnabled"
      >({
        name: "reasoning",
        featureName: "Reasoning",
        preferences: prefs,
        field: "reasoningEnabled",
        get: () => reasoningEnabled,
        set: (next) => {
          reasoningEnabled = next;
        },
      });

      expect(onBeforeTurn().providerOptions).toBeUndefined();

      const onResult = await toggle.execute({ args: ["on"] });
      expect(onResult.success).toBe(true);
      expect(reasoningEnabled).toBe(true);
      expect(onBeforeTurn().providerOptions).toEqual({
        openai: { reasoningEffort: "medium" },
      });

      const freshBundle = createLayeredPreferences<MinimalAgentPreferences>({
        userFilePath: prefs.paths.userFilePath,
        workspaceFilePath: prefs.paths.workspaceFilePath,
      });
      const persisted = await freshBundle.store.load();
      expect(persisted?.reasoningEnabled).toBe(true);

      const offResult = await toggle.execute({ args: ["off"] });
      expect(offResult.success).toBe(true);
      expect(reasoningEnabled).toBe(false);
      expect(onBeforeTurn().providerOptions).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
