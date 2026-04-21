import { describe, expect, it } from "vitest";
import type { ContextBudget } from "./compaction-policy";
import type { ContextTokenStats } from "./context-analysis";
import { generateContextSuggestions } from "./context-suggestions";

function createBudget(overrides?: Partial<ContextBudget>): ContextBudget {
  return {
    autoCompactAt: 500,
    effectiveContextWindow: 1000,
    hardLimitAt: 900,
    rawContextWindow: 1000,
    reservedForCompaction: 100,
    speculativeStartAt: 375,
    warningAt: 850,
    ...overrides,
  };
}

function createStats(
  overrides?: Partial<ContextTokenStats>
): ContextTokenStats {
  return {
    total: 1000,
    byRole: {
      system: 100,
      user: 300,
      assistant: 300,
      tool: 300,
    },
    toolResults: new Map(),
    duplicateReads: new Map(),
    largestMessages: [],
    ...overrides,
  };
}

describe("generateContextSuggestions", () => {
  it("warns when context reaches warning threshold", () => {
    const suggestions = generateContextSuggestions(
      createStats(),
      createBudget(),
      860
    );

    const warning = suggestions.find((item) =>
      item.message.startsWith("Context is")
    );
    expect(warning).toBeDefined();
    expect(warning?.level).toBe("warning");
    expect(warning?.message).toContain("96% full");
  });

  it("adds warning when tool results exceed 20% of total context", () => {
    const suggestions = generateContextSuggestions(
      createStats({
        total: 10_000,
        toolResults: new Map([["read_file", { count: 4, tokens: 2500 }]]),
      }),
      createBudget(),
      100
    );

    const toolWarning = suggestions.find((item) =>
      item.message.includes("Tool results: 25%")
    );

    expect(toolWarning).toBeDefined();
    expect(toolWarning?.level).toBe("warning");
    expect(toolWarning?.estimatedSavings).toBe(625);
  });

  it("reports duplicate reads with estimated wasted tokens", () => {
    const suggestions = generateContextSuggestions(
      createStats({
        duplicateReads: new Map([
          ["src/utils/math.ts", { count: 3, wastedTokens: 1200 }],
          ["src/utils/big.ts", { count: 2, wastedTokens: 6200 }],
        ]),
      }),
      createBudget(),
      100
    );

    const mathDuplicate = suggestions.find((item) =>
      item.message.includes("File src/utils/math.ts read 3 times")
    );
    const bigDuplicate = suggestions.find((item) =>
      item.message.includes("File src/utils/big.ts read 2 times")
    );

    expect(mathDuplicate).toBeDefined();
    expect(mathDuplicate?.level).toBe("info");
    expect(mathDuplicate?.estimatedSavings).toBe(1200);

    expect(bigDuplicate).toBeDefined();
    expect(bigDuplicate?.level).toBe("warning");
    expect(bigDuplicate?.estimatedSavings).toBe(6200);
  });

  it("warns when a single tool result exceeds 5k tokens", () => {
    const suggestions = generateContextSuggestions(
      createStats({
        total: 40_000,
        toolResults: new Map([["read_file", { count: 1, tokens: 6200 }]]),
      }),
      createBudget(),
      100
    );

    const largeToolResult = suggestions.find((item) =>
      item.message.includes("read_file: 6200 tokens")
    );

    expect(largeToolResult).toBeDefined();
    expect(largeToolResult?.level).toBe("warning");
    expect(largeToolResult?.estimatedSavings).toBe(3100);
  });
});
