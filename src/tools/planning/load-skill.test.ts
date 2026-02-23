import { describe, expect, it } from "bun:test";
import { executeLoadSkill } from "./load-skill";

describe("executeLoadSkill", () => {
  it("loads git-workflow skill successfully", async () => {
    const result = await executeLoadSkill({ skillName: "git-workflow" });

    expect(result).toContain("# Skill Loaded: git-workflow");
    expect(result).toContain("# Git Workflow Skill");
    expect(result).toContain("gh pr create");
  });

  it("returns error for non-existent skill", async () => {
    const result = await executeLoadSkill({ skillName: "non-existent-skill" });

    expect(result).toContain("Error: Skill 'non-existent-skill' not found");
    expect(result).toContain("system prompt");
  });

  it("loads skill with frontmatter", async () => {
    const result = await executeLoadSkill({ skillName: "git-workflow" });

    expect(result).toContain("name: Git Workflow");
    expect(result).toContain("description:");
    expect(result).toContain("triggers:");
  });

  it("loads skill with prompts prefix", async () => {
    const result = await executeLoadSkill({ skillName: "prompts:example" });

    expect(result).toContain("# Skill Loaded: prompts:example");
    expect(result).toContain("# Example Skill");
  });

  it("rejects path traversal attempts with ..", async () => {
    const result = await executeLoadSkill({ skillName: "../../../etc/passwd" });

    expect(result).toContain("Error: Invalid skill name");
    expect(result).toContain("cannot contain '..' or '/'");
  });

  it("rejects path traversal attempts with /", async () => {
    const result = await executeLoadSkill({ skillName: "foo/bar" });

    expect(result).toContain("Error: Invalid skill name");
    expect(result).toContain("cannot contain '..' or '/'");
  });
});
