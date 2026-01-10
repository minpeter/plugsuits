import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";

const SKILLS_DIR = ".claude/skills";

export async function loadSkills(): Promise<string> {
  try {
    const skillFiles = await glob("*.md", {
      cwd: SKILLS_DIR,
      absolute: false,
    });

    if (skillFiles.length === 0) {
      return "";
    }

    const skillContents = await Promise.all(
      skillFiles.map(async (file) => {
        const filePath = join(SKILLS_DIR, file);
        const content = await readFile(filePath, "utf-8");
        return `\n\n## Skill: ${file.replace(".md", "")}\n\n${content}`;
      })
    );

    return `\n\n---\n\n# Available Skills\n\nThe following specialized skills are available for complex workflows:\n${skillContents.join("\n\n---\n")}`;
  } catch {
    return "";
  }
}
