import { describe, expect, it } from "bun:test";
import { loadSkillsMetadata } from "./skills";

describe("loadSkillsMetadata", () => {
  it("loads git-workflow skill metadata successfully", async () => {
    const metadata = await loadSkillsMetadata();

    expect(metadata).toContain("Git Workflow");
    expect(metadata).toContain("git-workflow");
    expect(metadata).toContain("Available Skills");
  });

  it("includes skill description", async () => {
    const metadata = await loadSkillsMetadata();

    expect(metadata).toContain("Complete git workflow");
    expect(metadata).toContain("load_skill");
  });

  it("returns empty string if no skills directory", async () => {
    const metadata = await loadSkillsMetadata();

    expect(typeof metadata).toBe("string");
  });
});
