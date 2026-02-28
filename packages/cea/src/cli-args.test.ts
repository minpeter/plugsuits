import { describe, expect, it } from "bun:test";
import {
  parseProviderArg,
  parseReasoningCliOption,
  parseToolFallbackCliOption,
  parseTranslateCliOption,
} from "./cli-args";

describe("parseProviderArg", () => {
  it("returns 'anthropic' for valid anthropic arg", () => {
    expect(parseProviderArg("anthropic")).toBe("anthropic");
  });

  it("returns 'friendli' for valid friendli arg", () => {
    expect(parseProviderArg("friendli")).toBe("friendli");
  });

  it("returns null for unknown provider", () => {
    expect(parseProviderArg("openai")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseProviderArg(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseProviderArg("")).toBeNull();
  });
});

describe("parseTranslateCliOption", () => {
  it("returns true for --translate", () => {
    expect(parseTranslateCliOption("--translate")).toBe(true);
  });

  it("returns false for --no-translate", () => {
    expect(parseTranslateCliOption("--no-translate")).toBe(false);
  });

  it("returns null for unrecognized args", () => {
    expect(parseTranslateCliOption("--other")).toBeNull();
    expect(parseTranslateCliOption("translate")).toBeNull();
  });
});

describe("parseReasoningCliOption", () => {
  it("returns mode 'on' for --think", () => {
    const result = parseReasoningCliOption(["--think"], 0);
    expect(result).toEqual({ consumedArgs: 0, mode: "on" });
  });

  it("returns null for unrelated args", () => {
    expect(parseReasoningCliOption(["--model"], 0)).toBeNull();
    expect(parseReasoningCliOption(["foo"], 0)).toBeNull();
  });

  it("parses --reasoning-mode with valid value", () => {
    const result = parseReasoningCliOption(
      ["--reasoning-mode", "interleaved"],
      0
    );
    expect(result).toEqual({ consumedArgs: 1, mode: "interleaved" });
  });

  it("falls back to default when --reasoning-mode value is missing", () => {
    const result = parseReasoningCliOption(["--reasoning-mode"], 0);
    expect(result).toEqual({ consumedArgs: 0, mode: "off" });
  });

  it("falls back to default when --reasoning-mode is followed by another flag", () => {
    const result = parseReasoningCliOption(["--reasoning-mode", "--model"], 0);
    expect(result).toEqual({ consumedArgs: 0, mode: "off" });
  });

  it("falls back to default for invalid reasoning mode value", () => {
    const result = parseReasoningCliOption(["--reasoning-mode", "garbage"], 0);
    expect(result).toEqual({ consumedArgs: 1, mode: "off" });
  });

  it("handles valid aliases like 'enable' → 'on'", () => {
    const result = parseReasoningCliOption(["--reasoning-mode", "enable"], 0);
    expect(result).toEqual({ consumedArgs: 1, mode: "on" });
  });
});

describe("parseToolFallbackCliOption", () => {
  it("returns null for unrelated args", () => {
    expect(parseToolFallbackCliOption(["--model"], 0)).toBeNull();
  });

  it("parses --toolcall-mode with valid value", () => {
    const result = parseToolFallbackCliOption(
      ["--toolcall-mode", "morphxml"],
      0
    );
    expect(result).toEqual({ consumedArgs: 1, mode: "morphxml" });
  });

  it("uses DEFAULT_TOOL_FALLBACK_MODE when --toolcall-mode has no value", () => {
    const result = parseToolFallbackCliOption(["--toolcall-mode"], 0);
    expect(result).toEqual({ consumedArgs: 0, mode: "disable" });
  });

  it("uses DEFAULT_TOOL_FALLBACK_MODE when --toolcall-mode is followed by a flag", () => {
    const result = parseToolFallbackCliOption(
      ["--toolcall-mode", "--model"],
      0
    );
    expect(result).toEqual({ consumedArgs: 0, mode: "disable" });
  });

  it("parses --tool-fallback with valid value", () => {
    const result = parseToolFallbackCliOption(["--tool-fallback", "hermes"], 0);
    expect(result).toEqual({ consumedArgs: 1, mode: "hermes" });
  });

  it("uses LEGACY_ENABLED mode when --tool-fallback has no value", () => {
    const result = parseToolFallbackCliOption(["--tool-fallback"], 0);
    expect(result).toEqual({ consumedArgs: 0, mode: "morphxml" });
  });

  it("uses LEGACY_ENABLED mode when --tool-fallback is followed by a flag", () => {
    const result = parseToolFallbackCliOption(
      ["--tool-fallback", "--other"],
      0
    );
    expect(result).toEqual({ consumedArgs: 0, mode: "morphxml" });
  });

  it("falls back to appropriate default for invalid value", () => {
    const toolcall = parseToolFallbackCliOption(
      ["--toolcall-mode", "garbage"],
      0
    );
    expect(toolcall).toEqual({ consumedArgs: 1, mode: "disable" });

    const fallback = parseToolFallbackCliOption(
      ["--tool-fallback", "garbage"],
      0
    );
    expect(fallback).toEqual({ consumedArgs: 1, mode: "morphxml" });
  });

  it("handles correct index in multi-arg arrays", () => {
    const args = ["--model", "gpt-4", "--toolcall-mode", "hermes"];
    expect(parseToolFallbackCliOption(args, 0)).toBeNull();
    expect(parseToolFallbackCliOption(args, 2)).toEqual({
      consumedArgs: 1,
      mode: "hermes",
    });
  });
});
