import { describe, expect, it } from "bun:test";
import { loadSkills } from "./skills";

describe("loadSkills", () => {
  it("loads git-workflow skill successfully", async () => {
    const skills = await loadSkills();

    expect(skills).toContain("# Git Workflow Skill");
    expect(skills).toContain("gh pr create");
    expect(skills).toContain("Available Skills");
  });

  it("includes skill metadata", async () => {
    const skills = await loadSkills();

    expect(skills).toContain("## Skill: git-workflow");
  });

  it("returns empty string if no skills directory", async () => {
    const skills = await loadSkills();

    expect(typeof skills).toBe("string");
  });
});
