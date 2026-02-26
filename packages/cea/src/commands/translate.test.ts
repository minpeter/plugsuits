import { beforeEach, describe, expect, it } from "bun:test";
import { agentManager } from "../agent";
import { createTranslateCommand } from "./translate";

describe("translate command", () => {
  const command = createTranslateCommand();

  beforeEach(() => { agentManager.resetForTesting(); });

  it("reports current translation state when called without args", async () => {
    agentManager.setTranslationEnabled(true);

    const result = await command.execute({ args: [] });

    expect(result?.success).toBe(true);
    expect(result?.message).toContain("Translation is currently");
    expect(result?.message).toContain("enabled");
  });

  it("enables translation with on/enable/true", async () => {
    const onResult = await command.execute({ args: ["on"] });
    expect(onResult?.success).toBe(true);
    expect(agentManager.isTranslationEnabled()).toBe(true);
    expect(onResult?.message).toContain("Translation enabled");

    const enableResult = await command.execute({ args: ["enable"] });
    expect(enableResult?.success).toBe(true);
    expect(agentManager.isTranslationEnabled()).toBe(true);

    const trueResult = await command.execute({ args: ["true"] });
    expect(trueResult?.success).toBe(true);
    expect(agentManager.isTranslationEnabled()).toBe(true);
  });

  it("disables translation with off/disable/false", async () => {
    agentManager.setTranslationEnabled(true);

    const offResult = await command.execute({ args: ["off"] });
    expect(offResult?.success).toBe(true);
    expect(agentManager.isTranslationEnabled()).toBe(false);
    expect(offResult?.message).toContain("Translation disabled");

    agentManager.setTranslationEnabled(true);
    const disableResult = await command.execute({ args: ["disable"] });
    expect(disableResult?.success).toBe(true);
    expect(agentManager.isTranslationEnabled()).toBe(false);

    agentManager.setTranslationEnabled(true);
    const falseResult = await command.execute({ args: ["false"] });
    expect(falseResult?.success).toBe(true);
    expect(agentManager.isTranslationEnabled()).toBe(false);
  });

  it("rejects invalid arguments", async () => {
    const result = await command.execute({ args: ["maybe"] });

    expect(result?.success).toBe(false);
    expect(result?.message).toContain("Invalid argument");
    expect(result?.message).toContain("on");
    expect(result?.message).toContain("off");
  });
});
