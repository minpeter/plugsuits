import { describe, expect, it } from "bun:test";
import type { Command } from "@ai-sdk-tool/harness";
import { buildTuiCommandSet } from "./command-set";

describe("buildTuiCommandSet", () => {
  it("merges local commands with global help for autocomplete and execution", async () => {
    const localCommands: Command[] = [
      {
        name: "clear",
        description: "Start a new session",
        execute: () => ({
          success: true,
          action: { type: "new-session" },
        }),
      },
    ];

    const commandSet = buildTuiCommandSet(localCommands);

    expect(commandSet.commands.some((command) => command.name === "help")).toBe(
      true
    );
    expect(
      commandSet.commands.some((command) => command.name === "clear")
    ).toBe(true);

    const helpCommand = commandSet.commandLookup.get("help");
    const result = await helpCommand?.execute({ args: [] });

    expect(result?.success).toBe(true);
    expect(result?.message).toContain("/help - Show available commands");
    expect(result?.message).toContain("/clear - Start a new session");
  });

  it("preserves a custom local help command instead of overwriting it", async () => {
    const localHelp: Command = {
      name: "help",
      description: "Custom help",
      execute: () => ({
        success: true,
        message: "custom help",
      }),
    };

    const commandSet = buildTuiCommandSet([localHelp]);
    const helpCommand = commandSet.commandLookup.get("help");
    const result = await helpCommand?.execute({ args: [] });

    expect(result?.message).toBe("custom help");
  });
});
