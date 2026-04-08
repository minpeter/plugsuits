import { formatContextUsage } from "@ai-sdk-tool/harness";
import { describe, expect, it } from "vitest";

describe("formatContextUsage", () => {
  it("shows estimated baseline tokens instead of question marks when limit is known", () => {
    expect(
      formatContextUsage({
        limit: 20_000,
        percentage: 15,
        remaining: 17_000,
        source: "estimated",
        used: 3000,
      })
    ).toBe("3.0k/20.0k (15%)");
  });

  it("uses question marks only when the context limit itself is unknown", () => {
    expect(
      formatContextUsage({
        limit: 0,
        percentage: 0,
        remaining: 0,
        source: "estimated",
        used: 0,
      })
    ).toBe("?/0 (?)");
  });
});
