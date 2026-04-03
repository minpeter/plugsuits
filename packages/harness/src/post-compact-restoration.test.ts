import { describe, expect, it } from "vitest";
import { PostCompactRestorer } from "./post-compact-restoration";

function makeContent(tokens: number): string {
  return "a".repeat(tokens * 4);
}

describe("PostCompactRestorer", () => {
  it("returns undefined when there is no restorable context", () => {
    const restorer = new PostCompactRestorer();

    expect(restorer.getRestorationItems()).toEqual([]);
    expect(restorer.buildRestorationMessage()).toBeUndefined();
  });

  it("restores a single item within budget", () => {
    const restorer = new PostCompactRestorer({
      maxItemTokens: 100,
      maxTotalTokens: 100,
    });

    restorer.trackItem({
      content: "export const value = 1",
      label: "src/index.ts",
      priority: 10,
      type: "file",
    });

    expect(restorer.getRestorationItems()).toHaveLength(1);
    expect(restorer.getRestorationItems()[0]).toMatchObject({
      label: "src/index.ts",
      priority: 10,
      type: "file",
    });
  });

  it("selects highest priority items when budget is exceeded", () => {
    const restorer = new PostCompactRestorer({
      maxItemTokens: 10,
      maxTotalTokens: 10,
    });

    restorer.trackItem({
      content: makeContent(5),
      label: "low-priority",
      priority: 1,
      type: "context",
    });
    restorer.trackItem({
      content: makeContent(5),
      label: "mid-priority",
      priority: 5,
      type: "context",
    });
    restorer.trackItem({
      content: makeContent(5),
      label: "high-priority",
      priority: 10,
      type: "context",
    });

    expect(restorer.getRestorationItems().map((item) => item.label)).toEqual([
      "high-priority",
      "mid-priority",
    ]);
  });

  it("filters out items that exceed maxItemTokens", () => {
    const restorer = new PostCompactRestorer({
      maxItemTokens: 4,
      maxTotalTokens: 20,
    });

    restorer.trackItem({
      content: makeContent(5),
      label: "oversized",
      priority: 100,
      type: "file",
    });
    restorer.trackItem({
      content: makeContent(3),
      label: "small-enough",
      priority: 1,
      type: "skill",
    });

    expect(restorer.getRestorationItems().map((item) => item.label)).toEqual([
      "small-enough",
    ]);
  });

  it("evicts the lowest priority item when maxItems is exceeded", () => {
    const restorer = new PostCompactRestorer({
      maxItems: 2,
      maxItemTokens: 20,
      maxTotalTokens: 20,
    });

    restorer.trackItem({
      content: makeContent(2),
      label: "lowest",
      priority: 1,
      type: "context",
    });
    restorer.trackItem({
      content: makeContent(2),
      label: "highest",
      priority: 10,
      type: "context",
    });
    restorer.trackItem({
      content: makeContent(2),
      label: "middle",
      priority: 5,
      type: "context",
    });

    expect(restorer.getRestorationItems().map((item) => item.label)).toEqual([
      "highest",
      "middle",
    ]);
  });

  it("formats restoration message as markdown sections", () => {
    const restorer = new PostCompactRestorer();

    restorer.trackItem({
      content: "export const value = 1",
      label: "src/index.ts",
      priority: 10,
      type: "file",
    });
    restorer.trackItem({
      content: "Use git log and git diff before commit",
      label: "git-master",
      priority: 5,
      type: "skill",
    });

    expect(restorer.buildRestorationMessage()).toBe(
      `[Restored Context — recently accessed files and skills]

### file: src/index.ts
export const value = 1

### skill: git-master
Use git log and git diff before commit`
    );
  });
});
