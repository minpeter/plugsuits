import { describe, expect, test } from "bun:test";
import { executeLoadSkill } from "../tools/planning/load-skill";
import {
  parsePromptsCommandName,
  toPromptsCommandName,
} from "./skill-command-prefix";
import { loadAllSkills, loadSkillById } from "./skills";

describe("Skills Integration Tests", () => {
  test("loads both legacy and v2 skills", async () => {
    const skills = await loadAllSkills();

    // Should have at least git-workflow (legacy) and example (v2)
    expect(skills.length).toBeGreaterThanOrEqual(2);

    const legacySkill = skills.find((s) => s.id === "git-workflow");
    expect(legacySkill?.format).toBe("legacy");

    const v2Skill = skills.find((s) => s.id === "example");
    expect(v2Skill?.format).toBe("v2");
  });

  test("loads v2 skill with proper metadata", async () => {
    const result = await loadSkillById("example");
    expect(result).toBeTruthy();

    if (result) {
      expect(result.info.format).toBe("v2");
      expect(result.info.name).toBe("example");
      expect(result.info.description).toContain("agentskills.io");
      expect(result.info.dirPath).toBeTruthy();
      expect(result.content).toContain("# Example Skill");
    }
  });

  test("executeLoadSkill works with v2 skills", async () => {
    const result = await executeLoadSkill({ skillName: "example" });

    expect(result).toContain("# Skill Loaded: example");
    expect(result).toContain("[Bundled (v2)]");
    expect(result).toContain("# Example Skill");
  });

  test("executeLoadSkill loads subdirectory files with relativePath", async () => {
    const setupScript = await executeLoadSkill({
      skillName: "example",
      relativePath: "scripts/setup.sh",
    });

    expect(setupScript).toContain("# Skill File: example/scripts/setup.sh");
    expect(setupScript).toContain("#!/bin/bash");
    expect(setupScript).toContain("Setup script for example skill");

    const apiDocs = await executeLoadSkill({
      skillName: "example",
      relativePath: "references/api.md",
    });

    expect(apiDocs).toContain("# Skill File: example/references/api.md");
    expect(apiDocs).toContain("# API Reference");
    expect(apiDocs).toContain("/api/health");
  });

  test("executeLoadSkill prevents path traversal", async () => {
    const result = await executeLoadSkill({
      skillName: "example",
      relativePath: "../../../package.json",
    });

    expect(result).toContain("Error: Invalid relative path");
    expect(result).toContain("cannot contain '..'");
  });

  test("executeLoadSkill rejects absolute paths", async () => {
    const result = await executeLoadSkill({
      skillName: "example",
      relativePath: "/etc/passwd",
    });

    expect(result).toContain("Error: Invalid relative path");
  });

  test("executeLoadSkill with relativePath only works with v2 skills", async () => {
    const result = await executeLoadSkill({
      skillName: "git-workflow",
      relativePath: "some-file.txt",
    });

    expect(result).toContain(
      "Error: Skill 'git-workflow' is a legacy format skill"
    );
    expect(result).toContain("Only v2 skills support subdirectory files");
  });

  test("formats prompts-prefixed slash command names", () => {
    expect(toPromptsCommandName("rams")).toBe("prompts:rams");
    expect(toPromptsCommandName("prompts:rams")).toBe("prompts:rams");
  });

  test("parses prompts-prefixed slash command names", () => {
    expect(parsePromptsCommandName("prompts:rams")).toBe("rams");
    expect(parsePromptsCommandName("prompts:")).toBeNull();
    expect(parsePromptsCommandName("rams")).toBeNull();
  });

  test("loads v2 skill by prompts-prefixed name", async () => {
    const result = await loadSkillById("prompts:example");

    expect(result).toBeTruthy();
    expect(result?.info.id).toBe("example");
    expect(result?.info.format).toBe("v2");
  });
});
