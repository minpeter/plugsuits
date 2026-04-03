import { describe, expect, it } from "vitest";
import { createCompactCommand } from "./compact";

describe("compact command", () => {
  it("returns a compact command action", async () => {
    const result = await createCompactCommand().execute({ args: [] });
    expect(result.success).toBe(true);
    expect(result.action).toEqual({ type: "compact" });
    expect(result.message).toBe("Compaction triggered.");
  });

  it("keeps summarize alias for backward compatibility", () => {
    const command = createCompactCommand();
    expect(command.aliases).toContain("summarize");
  });
});
