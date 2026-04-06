import { describe, expect, it, vi } from "vitest";
import { createCompactCommand } from "./compact";

describe("compact command", () => {
  it("triggers compaction directly", async () => {
    const compact = vi.fn(async () => undefined);
    const result = await createCompactCommand({
      messageHistory: { compact } as never,
    }).execute({ args: [] });
    expect(result.success).toBe(true);
    expect(compact).toHaveBeenCalledOnce();
    expect(result.message).toBe("Compaction completed.");
  });

  it("keeps summarize alias for backward compatibility", () => {
    const command = createCompactCommand({
      messageHistory: { compact: async () => undefined } as never,
    });
    expect(command.aliases).toContain("summarize");
  });
});
