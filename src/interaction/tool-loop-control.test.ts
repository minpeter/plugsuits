import { describe, expect, it } from "bun:test";
import {
  MANUAL_TOOL_LOOP_MAX_STEPS,
  shouldContinueManualToolLoop,
} from "./tool-loop-control";

describe("tool loop control", () => {
  it("continues when finish reason is tool-calls", () => {
    expect(shouldContinueManualToolLoop("tool-calls")).toBe(true);
  });

  it("continues when finish reason is unknown", () => {
    expect(shouldContinueManualToolLoop("unknown")).toBe(true);
  });

  it("stops when finish reason is stop", () => {
    expect(shouldContinueManualToolLoop("stop")).toBe(false);
  });

  it("uses the expected safety cap", () => {
    expect(MANUAL_TOOL_LOOP_MAX_STEPS).toBe(200);
  });
});
