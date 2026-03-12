import { describe, expect, it } from "vitest";
import {
  normalizeFinishReason,
  shouldContinueManualToolLoop,
} from "./tool-loop-control";

describe("tool loop control", () => {
  it("continues when finish reason is tool-calls", () => {
    expect(shouldContinueManualToolLoop("tool-calls")).toBe(true);
  });

  it("stops when finish reason is unknown", () => {
    expect(shouldContinueManualToolLoop("unknown")).toBe(false);
  });

  it("normalizes provider-specific tool finish reasons", () => {
    expect(normalizeFinishReason("tool_calls")).toBe("tool-calls");
    expect(normalizeFinishReason("tool_use")).toBe("tool-calls");
    expect(normalizeFinishReason("function_call")).toBe("tool-calls");
  });

  it("continues for normalized provider aliases", () => {
    expect(shouldContinueManualToolLoop("tool_calls")).toBe(true);
    expect(shouldContinueManualToolLoop("tool_use")).toBe(true);
    expect(shouldContinueManualToolLoop("function_call")).toBe(true);
  });

  it("stops when finish reason is stop", () => {
    expect(shouldContinueManualToolLoop("stop")).toBe(false);
  });
});
