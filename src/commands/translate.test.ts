import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { agentManager } from "../agent";
import { createTranslateCommand } from "./translate";

describe("translate command", () => {
  const command = createTranslateCommand();
  let originalState: boolean;

  beforeEach(() => {
    originalState = agentManager.isUserInputTranslationEnabled();
    agentManager.setUserInputTranslationEnabled(false);
  });

  afterEach(() => {
    agentManager.setUserInputTranslationEnabled(originalState);
  });

  it("reports current translation state when called without args", async () => {
    agentManager.setUserInputTranslationEnabled(true);

    const result = await command.execute({ args: [] });

    expect(result?.success).toBe(true);
    expect(result?.message).toContain("Prompt translation is currently");
    expect(result?.message).toContain("enabled");
  });

  it("enables translation with on/enable/true", async () => {
    const onResult = await command.execute({ args: ["on"] });
    expect(onResult?.success).toBe(true);
    expect(agentManager.isUserInputTranslationEnabled()).toBe(true);
    expect(onResult?.message).toContain("Prompt translation enabled");

    const enableResult = await command.execute({ args: ["enable"] });
    expect(enableResult?.success).toBe(true);
    expect(agentManager.isUserInputTranslationEnabled()).toBe(true);

    const trueResult = await command.execute({ args: ["true"] });
    expect(trueResult?.success).toBe(true);
    expect(agentManager.isUserInputTranslationEnabled()).toBe(true);
  });

  it("disables translation with off/disable/false", async () => {
    agentManager.setUserInputTranslationEnabled(true);

    const offResult = await command.execute({ args: ["off"] });
    expect(offResult?.success).toBe(true);
    expect(agentManager.isUserInputTranslationEnabled()).toBe(false);
    expect(offResult?.message).toContain("Prompt translation disabled");

    agentManager.setUserInputTranslationEnabled(true);
    const disableResult = await command.execute({ args: ["disable"] });
    expect(disableResult?.success).toBe(true);
    expect(agentManager.isUserInputTranslationEnabled()).toBe(false);

    agentManager.setUserInputTranslationEnabled(true);
    const falseResult = await command.execute({ args: ["false"] });
    expect(falseResult?.success).toBe(true);
    expect(agentManager.isUserInputTranslationEnabled()).toBe(false);
  });

  it("rejects invalid arguments", async () => {
    const result = await command.execute({ args: ["maybe"] });

    expect(result?.success).toBe(false);
    expect(result?.message).toContain("Invalid argument");
    expect(result?.message).toContain("on");
    expect(result?.message).toContain("off");
  });
});
