import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { agentManager } from "../agent";
import {
  DEFAULT_TOOL_FALLBACK_MODE,
  LEGACY_ENABLED_TOOL_FALLBACK_MODE,
  TOOL_FALLBACK_MODES,
  type ToolFallbackMode,
} from "../tool-fallback-mode";
import { createHelpCommand } from "./help";
import { executeCommand, getCommands, registerCommand } from "./index";
import { createReasoningModeCommand } from "./reasoning-mode";
import { createToolFallbackCommand } from "./tool-fallback";
import type { Command } from "./types";

let commandCounter = 0;

const nextCommandName = (prefix: string): string => {
  commandCounter += 1;
  return `${prefix}-${commandCounter}`;
};

describe("Command aliases", () => {
  it("executes canonical command via alias", async () => {
    const canonicalName = nextCommandName("clear");
    const aliasName = nextCommandName("new");

    registerCommand({
      name: canonicalName,
      aliases: [aliasName],
      description: "Alias command test",
      execute: () => ({
        success: true,
        message: `resolved:${canonicalName}`,
      }),
    });

    const result = await executeCommand(`/${aliasName}`);

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.message).toBe(`resolved:${canonicalName}`);
  });

  it("renders merged display name in help output", async () => {
    const commandMap = new Map<string, Command>();
    commandMap.set("clear", {
      name: "clear",
      displayName: "clear (new)",
      aliases: ["new"],
      description: "Start a new session",
      execute: () => ({ success: true, action: "new-session" }),
    });

    const help = createHelpCommand(() => commandMap);
    const result = await help.execute({ args: [] });

    expect(result.success).toBe(true);
    expect(result.message).toContain("/clear (new) - Start a new session");
    expect(result.message).not.toContain("/new - Start a new session");
  });
});

describe("Skill command prefixes", () => {
  it("keeps non-command skills addressable without prompts prefix", async () => {
    const result = await executeCommand("/example");

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result && "isSkill" in result && result.isSkill).toBe(true);

    if (result && "isSkill" in result && result.isSkill) {
      expect(result.skillId).toBe("prompts:example");
    }
  });

  it("resolves prompts prefix for non-command skills", async () => {
    const result = await executeCommand("/prompts:example");

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result && "isSkill" in result && result.isSkill).toBe(true);

    if (result && "isSkill" in result && result.isSkill) {
      expect(result.skillId).toBe("prompts:example");
    }
  });
});

describe("Reasoning mode command", () => {
  let originalMode: ReturnType<typeof agentManager.getReasoningMode>;
  let originalProvider: ReturnType<typeof agentManager.getProvider>;
  let originalModelId: ReturnType<typeof agentManager.getModelId>;

  beforeEach(() => {
    originalMode = agentManager.getReasoningMode();
    originalProvider = agentManager.getProvider();
    originalModelId = agentManager.getModelId();
    agentManager.setProvider("friendli");
    agentManager.setModelId("MiniMaxAI/MiniMax-M2.5");
    agentManager.setReasoningMode("on");
  });

  afterEach(() => {
    agentManager.setProvider(originalProvider);
    agentManager.setModelId(originalModelId);
    agentManager.setReasoningMode(originalMode);
  });

  it("supports /think alias for /reasoning-mode", async () => {
    if (!getCommands().has("reasoning-mode")) {
      registerCommand(createReasoningModeCommand());
    }

    const result = await executeCommand("/think interleaved");
    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(agentManager.getReasoningMode()).toBe("interleaved");
  });

  it("rejects unsupported mode for current model", async () => {
    if (!getCommands().has("reasoning-mode")) {
      registerCommand(createReasoningModeCommand());
    }

    const result = await executeCommand("/reasoning-mode preserved");
    expect(result).not.toBeNull();
    expect(result?.success).toBe(false);
    expect(result?.message).toContain("not supported");
  });
});

describe("Tool fallback command", () => {
  let originalMode: ToolFallbackMode;

  beforeEach(() => {
    originalMode = agentManager.getToolFallbackMode();
  });

  afterEach(() => {
    agentManager.setToolFallbackMode(originalMode);
  });

  it("shows mode usage when called without arguments", async () => {
    const command = createToolFallbackCommand();
    const result = await command.execute({ args: [] });

    expect(result.success).toBe(true);
    expect(result.message).toContain("Tool fallback mode:");
    expect(result.message).toContain(TOOL_FALLBACK_MODES.join("|"));
  });

  it("sets explicit mode values", async () => {
    const command = createToolFallbackCommand();

    const result = await command.execute({ args: ["hermes"] });

    expect(result.success).toBe(true);
    expect(agentManager.getToolFallbackMode()).toBe("hermes");
  });

  it("accepts legacy on/off values", async () => {
    const command = createToolFallbackCommand();

    await command.execute({ args: ["on"] });
    expect(agentManager.getToolFallbackMode()).toBe(
      LEGACY_ENABLED_TOOL_FALLBACK_MODE
    );

    await command.execute({ args: ["off"] });
    expect(agentManager.getToolFallbackMode()).toBe(DEFAULT_TOOL_FALLBACK_MODE);
  });
});
