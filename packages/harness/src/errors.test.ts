import { describe, expect, it } from "vitest";
import { AgentError, AgentErrorCode, isAgentError } from "./errors";

describe("isAgentError()", () => {
  it("returns true for AgentError instances", () => {
    expect(
      isAgentError(new AgentError(AgentErrorCode.MAX_ITERATIONS, "hit limit"))
    ).toBe(true);
  });

  it("returns false for plain Error", () => {
    expect(isAgentError(new Error("generic"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAgentError(null)).toBe(false);
  });

  it("returns false for string", () => {
    expect(isAgentError("error string")).toBe(false);
  });
});
