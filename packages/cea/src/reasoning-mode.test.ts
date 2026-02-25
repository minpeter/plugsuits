import { describe, expect, it } from "bun:test";
import { parseReasoningMode } from "./reasoning-mode";

describe("parseReasoningMode", () => {
  it("parses canonical reasoning modes", () => {
    expect(parseReasoningMode("off")).toBe("off");
    expect(parseReasoningMode("on")).toBe("on");
    expect(parseReasoningMode("interleaved")).toBe("interleaved");
    expect(parseReasoningMode("preserved")).toBe("preserved");
  });

  it("parses compatibility aliases", () => {
    expect(parseReasoningMode("enable")).toBe("on");
    expect(parseReasoningMode("true")).toBe("on");
    expect(parseReasoningMode("disable")).toBe("off");
    expect(parseReasoningMode("false")).toBe("off");
    expect(parseReasoningMode("interleave")).toBe("interleaved");
    expect(parseReasoningMode("preserve")).toBe("preserved");
  });

  it("returns null for unknown values", () => {
    expect(parseReasoningMode("something-else")).toBeNull();
  });
});
