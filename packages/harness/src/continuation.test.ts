import { describe, expect, it } from "vitest";
import type { ContinuationVariant } from "./compaction-types";
import { createContinuationMessage, getContinuationText } from "./continuation";

describe("createContinuationMessage", () => {
  it("manual variant returns assistant message", () => {
    const msg = createContinuationMessage("manual");
    expect(msg.role).toBe("assistant");
    expect(msg.isContinuation).toBe(true);
    expect(msg.variant).toBe("manual");
    expect(msg.content.length).toBeGreaterThan(0);
  });

  it("auto-with-replay variant returns assistant message", () => {
    const msg = createContinuationMessage("auto-with-replay");
    expect(msg.role).toBe("assistant");
    expect(msg.isContinuation).toBe(true);
    expect(msg.variant).toBe("auto-with-replay");
    expect(msg.content).toContain("request");
  });

  it("tool-loop variant returns assistant message", () => {
    const msg = createContinuationMessage("tool-loop");
    expect(msg.role).toBe("assistant");
    expect(msg.isContinuation).toBe(true);
    expect(msg.variant).toBe("tool-loop");
    expect(msg.content).toContain("tool");
  });

  it("all variants produce messages under 100 tokens (~400 chars)", () => {
    const variants: ContinuationVariant[] = [
      "manual",
      "auto-with-replay",
      "tool-loop",
    ];
    for (const variant of variants) {
      const msg = createContinuationMessage(variant);
      expect(msg.content.length).toBeLessThan(400);
    }
  });
});

describe("getContinuationText", () => {
  it("manual returns correct text", () => {
    const text = getContinuationText("manual");
    expect(text).toContain("summarized");
  });

  it("auto-with-replay returns correct text", () => {
    const text = getContinuationText("auto-with-replay");
    expect(text).toContain("summarized");
  });

  it("tool-loop returns correct text", () => {
    const text = getContinuationText("tool-loop");
    expect(text).toContain("compacted");
  });
});
