import { describe, expect, it } from "bun:test";
import { MessageHistory } from "@ai-sdk-tool/harness";
import { createCompactCommand } from "./compact";

const exec = (history: MessageHistory) =>
  createCompactCommand(() => history).execute({ args: [] });

describe("compact command", () => {
  const summarizeFn = () =>
    Promise.resolve(
      "## Summary\nCompacted\n\n## Context\n- test\n\n## Current State\n- done"
    );

  it("returns failure when compaction is not enabled", async () => {
    const history = new MessageHistory();
    const result = await exec(history);
    expect(result.success).toBe(false);
    expect(result.message).toContain("not enabled");
  });

  it("returns nothing-to-compact for fewer than 2 messages", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 2048,
        reserveTokens: 512,
        summarizeFn,
      },
    });
    history.addUserMessage("hi");
    const result = await exec(history);
    expect(result.success).toBe(true);
    expect(result.message).toContain("at least 2 messages");
  });

  it("compacts a conversation and reports token stats", async () => {
    let summarizeCalls = 0;
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 2048,
        reserveTokens: 512,
        summarizeFn: () => {
          summarizeCalls += 1;
          return summarizeFn();
        },
      },
    });
    for (let i = 0; i < 20; i++) {
      history.addUserMessage(`Tell me about computing. ${"x".repeat(200)}`);
      history.addModelMessages([
        {
          role: "assistant",
          content: [
            { type: "text", text: `Computing evolved. ${"y".repeat(200)}` },
          ],
        },
      ]);
    }
    const result = await exec(history);
    expect(result.success).toBe(true);
    expect(summarizeCalls).toBeGreaterThan(0);
    expect(result.message).toContain("→");
    expect(result.message).toContain("messages");
  });

  it("never shows negative reduction percentage", async () => {
    const history = new MessageHistory({
      compaction: {
        enabled: true,
        maxTokens: 100_000,
        reserveTokens: 512,
        summarizeFn,
      },
    });
    history.addUserMessage("hello");
    history.addModelMessages([
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    const result = await exec(history);
    expect(result.success).toBe(true);
    expect(result.message).not.toContain("-");
  });

  it("fails when summarizeFn is not configured", async () => {
    const history = new MessageHistory({
      compaction: { enabled: true, maxTokens: 2048, reserveTokens: 512 },
    });
    history.addUserMessage("hello");
    history.addModelMessages([{ role: "assistant", content: "world" }]);

    const result = await exec(history);

    expect(result.success).toBe(false);
    expect(result.message).toContain("summarizer is not configured");
  });
});
