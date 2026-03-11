import { describe, expect, it } from "bun:test";
import {
  normalizeRawArgs,
  resolveSharedConfig,
  type SharedArgs,
} from "./cli-defs";

describe("normalizeRawArgs", () => {
  it("normalizes --tool-fallback alone", () => {
    expect(normalizeRawArgs(["--tool-fallback"])).toEqual([
      "--toolcall-mode",
      "morphxml",
    ]);
  });

  it("normalizes --tool-fallback hermes", () => {
    expect(normalizeRawArgs(["--tool-fallback", "hermes"])).toEqual([
      "--toolcall-mode",
      "hermes",
    ]);
  });

  it("normalizes --tool-fallback qwen3coder", () => {
    expect(normalizeRawArgs(["--tool-fallback", "qwen3coder"])).toEqual([
      "--toolcall-mode",
      "qwen3coder",
    ]);
  });

  it("normalizes --tool-fallback garbage to morphxml", () => {
    expect(normalizeRawArgs(["--tool-fallback", "garbage"])).toEqual([
      "--toolcall-mode",
      "morphxml",
    ]);
  });

  it("normalizes --tool-fallback before another flag", () => {
    expect(normalizeRawArgs(["--tool-fallback", "--other"])).toEqual([
      "--toolcall-mode",
      "morphxml",
      "--other",
    ]);
  });

  it("normalizes --tool-fallback on", () => {
    expect(normalizeRawArgs(["--tool-fallback", "on"])).toEqual([
      "--toolcall-mode",
      "morphxml",
    ]);
  });

  it("normalizes --tool-fallback off", () => {
    expect(normalizeRawArgs(["--tool-fallback", "off"])).toEqual([
      "--toolcall-mode",
      "disable",
    ]);
  });

  it("normalizes --reasoning-mode enable", () => {
    expect(normalizeRawArgs(["--reasoning-mode", "enable"])).toEqual([
      "--reasoning-mode",
      "on",
    ]);
  });

  it("normalizes --reasoning-mode true", () => {
    expect(normalizeRawArgs(["--reasoning-mode", "true"])).toEqual([
      "--reasoning-mode",
      "on",
    ]);
  });

  it("normalizes --reasoning-mode disable", () => {
    expect(normalizeRawArgs(["--reasoning-mode", "disable"])).toEqual([
      "--reasoning-mode",
      "off",
    ]);
  });

  it("normalizes --reasoning-mode interleave", () => {
    expect(normalizeRawArgs(["--reasoning-mode", "interleave"])).toEqual([
      "--reasoning-mode",
      "interleaved",
    ]);
  });

  it("normalizes --reasoning-mode preserve", () => {
    expect(normalizeRawArgs(["--reasoning-mode", "preserve"])).toEqual([
      "--reasoning-mode",
      "preserved",
    ]);
  });

  it("passes through valid --reasoning-mode on", () => {
    expect(normalizeRawArgs(["--reasoning-mode", "on"])).toEqual([
      "--reasoning-mode",
      "on",
    ]);
  });

  it("passes through garbage --reasoning-mode value", () => {
    expect(normalizeRawArgs(["--reasoning-mode", "garbage"])).toEqual([
      "--reasoning-mode",
      "garbage",
    ]);
  });

  it("normalizes --toolcall-mode on", () => {
    expect(normalizeRawArgs(["--toolcall-mode", "on"])).toEqual([
      "--toolcall-mode",
      "morphxml",
    ]);
  });

  it("normalizes --toolcall-mode off", () => {
    expect(normalizeRawArgs(["--toolcall-mode", "off"])).toEqual([
      "--toolcall-mode",
      "disable",
    ]);
  });

  it("keeps args unchanged when no special flags", () => {
    expect(normalizeRawArgs(["--model", "foo", "--prompt", "bar"])).toEqual([
      "--model",
      "foo",
      "--prompt",
      "bar",
    ]);
  });

  it("normalizes multiple combined flags", () => {
    expect(
      normalizeRawArgs(["--model", "foo", "--tool-fallback", "--think"])
    ).toEqual(["--model", "foo", "--toolcall-mode", "morphxml", "--think"]);
  });

  it("does not mutate input array", () => {
    const input = ["--tool-fallback", "on"];
    const snapshot = [...input];

    const output = normalizeRawArgs(input);

    expect(input).toEqual(snapshot);
    expect(output).toEqual(["--toolcall-mode", "morphxml"]);
    expect(output).not.toBe(input);
  });
});

describe("resolveSharedConfig", () => {
  it("uses explicit reasoning-mode on without think", () => {
    const args: SharedArgs = { "reasoning-mode": "on" };
    expect(resolveSharedConfig(args).reasoningMode).toBe("on");
  });

  it("uses think true when reasoning-mode is absent", () => {
    const args: SharedArgs = { think: true };
    expect(resolveSharedConfig(args).reasoningMode).toBe("on");
  });

  it("explicit reasoning-mode wins over think", () => {
    const args: SharedArgs = { "reasoning-mode": "off", think: true };
    expect(resolveSharedConfig(args).reasoningMode).toBe("off");
  });

  it("returns null reasoning mode when neither set", () => {
    const args: SharedArgs = {};
    expect(resolveSharedConfig(args).reasoningMode).toBeNull();
  });

  it("maps provider anthropic", () => {
    const args: SharedArgs = { provider: "anthropic" };
    expect(resolveSharedConfig(args).provider).toBe("anthropic");
  });

  it("maps provider undefined to null", () => {
    const args: SharedArgs = {};
    expect(resolveSharedConfig(args).provider).toBeNull();
  });

  it("maps model value", () => {
    const args: SharedArgs = { model: "foo" };
    expect(resolveSharedConfig(args).model).toBe("foo");
  });

  it("maps model undefined to null", () => {
    const args: SharedArgs = {};
    expect(resolveSharedConfig(args).model).toBeNull();
  });

  it("uses explicit toolcall-mode", () => {
    const args: SharedArgs = { "toolcall-mode": "hermes" };
    expect(resolveSharedConfig(args).toolFallbackMode).toBe("hermes");
  });

  it("uses default toolcall-mode when undefined", () => {
    const args: SharedArgs = {};
    expect(resolveSharedConfig(args).toolFallbackMode).toBe("disable");
  });

  it("uses translate false", () => {
    const args: SharedArgs = { translate: false };
    expect(resolveSharedConfig(args).translateUserPrompts).toBe(false);
  });

  it("defaults translate to true when undefined", () => {
    const args: SharedArgs = {};
    expect(resolveSharedConfig(args).translateUserPrompts).toBe(true);
  });
});
