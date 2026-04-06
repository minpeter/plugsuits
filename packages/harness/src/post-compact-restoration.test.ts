import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { CheckpointMessage } from "./compaction-types";
import { PostCompactRestorer } from "./post-compact-restoration";
import { estimateTokens } from "./token-utils";

function makeContent(tokens: number): string {
  return "a".repeat(tokens * 4);
}

let checkpointId = 0;

function makeCheckpointMessage(message: ModelMessage): CheckpointMessage {
  checkpointId += 1;

  return {
    createdAt: checkpointId,
    id: `msg-${checkpointId}`,
    isSummary: false,
    message,
  };
}

describe("PostCompactRestorer", () => {
  it("returns undefined when there is no restorable context", () => {
    const restorer = new PostCompactRestorer();

    expect(restorer.getRestorationItems()).toEqual([]);
    expect(restorer.buildRestorationMessage()).toBeUndefined();
    expect(restorer.buildRestorationMessages()).toBeUndefined();
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

  it("truncates items that exceed maxItemTokens", () => {
    const restorer = new PostCompactRestorer({
      maxItemTokens: 20,
      maxTotalTokens: 100,
    });

    const oversizedContent = makeContent(100);

    restorer.trackItem({
      content: oversizedContent,
      label: "oversized",
      priority: 100,
      type: "file",
    });

    const [item] = restorer.getRestorationItems();

    expect(item).toBeDefined();
    expect(item?.label).toBe("oversized");
    expect(item?.content).toContain("[... truncated]");
    expect(item?.content.startsWith("a".repeat(64))).toBe(true);
    expect(item?.tokens).toBeLessThan(estimateTokens(oversizedContent));
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

  it("filters tracked items already present in kept messages", () => {
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
    restorer.trackItem({
      content: "Use git log and git diff before commit",
      label: "git-master",
      priority: 5,
      type: "skill",
    });

    restorer.filterAgainstKeptMessages([
      makeCheckpointMessage({
        role: "assistant",
        content: "Already loaded from src/index.ts",
      }),
    ]);

    expect(restorer.getRestorationItems().map((item) => item.label)).toEqual([
      "git-master",
    ]);
  });

  it("formats restoration message as structured XML-like sections", () => {
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

    const message = restorer.buildRestorationMessage();

    expect(message).toContain(
      "[Restored context after compaction — files and skills from before compaction]"
    );
    expect(message).toContain('<restored-file label="src/index.ts">');
    expect(message).toContain("export const value = 1");
    expect(message).toContain("</restored-file>");
    expect(message).toContain('<restored-skill label="git-master">');
    expect(message).toContain("Use git log and git diff before commit");
    expect(message).toContain("</restored-skill>");
  });

  it("buildRestorationMessages returns a user message array", () => {
    const restorer = new PostCompactRestorer();

    restorer.trackItem({
      content: "export const value = 1",
      label: "src/index.ts",
      priority: 10,
      type: "file",
    });

    const message = restorer.buildRestorationMessage();

    expect(restorer.buildRestorationMessages()).toEqual([
      {
        role: "user",
        content: message,
      },
    ]);
  });

  it("setMaxTotalTokens dynamically reduces budget and excludes items", () => {
    const restorer = new PostCompactRestorer({
      maxItemTokens: 100,
      maxTotalTokens: 100,
    });

    restorer.trackItem({
      content: makeContent(8),
      label: "large-item",
      priority: 10,
      type: "file",
    });
    restorer.trackItem({
      content: makeContent(3),
      label: "small-item",
      priority: 5,
      type: "file",
    });

    expect(restorer.getRestorationItems()).toHaveLength(2);

    restorer.setMaxTotalTokens(5);

    const items = restorer.getRestorationItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe("small-item");
  });

  it("setMaxTotalTokens to zero excludes all items", () => {
    const restorer = new PostCompactRestorer({ maxTotalTokens: 100 });

    restorer.trackItem({
      content: "hello",
      label: "test",
      priority: 10,
      type: "context",
    });

    restorer.setMaxTotalTokens(0);
    expect(restorer.getRestorationItems()).toEqual([]);
  });

  it("filterAgainstKeptMessages uses boundary matching, not substring", () => {
    const restorer = new PostCompactRestorer({
      maxItemTokens: 100,
      maxTotalTokens: 100,
    });

    restorer.trackItem({
      content: "const x = 1",
      label: "src/index.ts",
      priority: 10,
      type: "file",
    });
    restorer.trackItem({
      content: "const y = 2",
      label: "src/index.tsx",
      priority: 10,
      type: "file",
    });

    restorer.filterAgainstKeptMessages([
      makeCheckpointMessage({
        role: "assistant",
        content: "I read src/index.ts and found the exports",
      }),
    ]);

    const remaining = restorer.getRestorationItems().map((i) => i.label);
    expect(remaining).toEqual(["src/index.tsx"]);
  });

  it("filterAgainstKeptMessages matches labels surrounded by non-word chars", () => {
    const restorer = new PostCompactRestorer({
      maxItemTokens: 100,
      maxTotalTokens: 100,
    });

    restorer.trackItem({
      content: "skill content",
      label: "git-master",
      priority: 5,
      type: "skill",
    });

    restorer.filterAgainstKeptMessages([
      makeCheckpointMessage({
        role: "user",
        content: "Load skill: git-master for this task",
      }),
    ]);

    expect(restorer.getRestorationItems()).toEqual([]);
  });

  it("filterAgainstKeptMessages matches label at end of sentence (trailing period)", () => {
    const restorer = new PostCompactRestorer({
      maxItemTokens: 100,
      maxTotalTokens: 100,
    });

    restorer.trackItem({
      content: "const x = 1",
      label: "src/index.ts",
      priority: 10,
      type: "file",
    });

    restorer.filterAgainstKeptMessages([
      makeCheckpointMessage({
        role: "assistant",
        content: "I already read src/index.ts.",
      }),
    ]);

    expect(restorer.getRestorationItems()).toEqual([]);
  });

  it("filterAgainstKeptMessages still distinguishes .ts from .tsx with trailing period", () => {
    const restorer = new PostCompactRestorer({
      maxItemTokens: 100,
      maxTotalTokens: 100,
    });

    restorer.trackItem({
      content: "const x = 1",
      label: "src/index.ts",
      priority: 10,
      type: "file",
    });
    restorer.trackItem({
      content: "const y = 2",
      label: "src/index.tsx",
      priority: 10,
      type: "file",
    });

    restorer.filterAgainstKeptMessages([
      makeCheckpointMessage({
        role: "assistant",
        content: "I already read src/index.tsx.",
      }),
    ]);

    const remaining = restorer.getRestorationItems().map((i) => i.label);
    expect(remaining).toEqual(["src/index.ts"]);
  });
});
