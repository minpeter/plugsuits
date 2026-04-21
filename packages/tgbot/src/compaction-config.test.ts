import { describe, expect, it } from "vitest";
import { buildCompactionTokenBudget } from "./compaction-config";

describe("buildCompactionTokenBudget", () => {
  it("keeps small context budgets within the configured context limit", () => {
    for (const contextLimit of [1, 100, 1000, 8000]) {
      const budget = buildCompactionTokenBudget(contextLimit);

      expect(budget.reserveTokens).toBeLessThanOrEqual(contextLimit);
      expect(budget.maxTokens).toBeLessThanOrEqual(
        contextLimit - budget.reserveTokens
      );
      expect(
        budget.keepRecentTokens + budget.reserveTokens
      ).toBeLessThanOrEqual(contextLimit);
    }
  });
});
