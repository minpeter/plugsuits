import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "ai";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "../../skills");

const inputSchema = z.object({
  skillName: z
    .string()
    .describe("Name of the skill to load (e.g., 'git-workflow')"),
});

export type LoadSkillInput = z.infer<typeof inputSchema>;

export async function executeLoadSkill({
  skillName,
}: LoadSkillInput): Promise<string> {
  if (!skillName || skillName.trim() === "") {
    throw new Error("skillName must be a non-empty string");
  }

  if (skillName.includes("..") || skillName.includes("/")) {
    return `Error: Invalid skill name '${skillName}'. Skill names cannot contain '..' or '/'.`;
  }

  const skillPath = join(SKILLS_DIR, `${skillName}.md`);

  try {
    const content = await readFile(skillPath, "utf-8");
    return `# Skill Loaded: ${skillName}\n\n${content}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return `Error: Skill '${skillName}' not found. This skill is not bundled with the package.`;
    }
    throw error;
  }
}

export const loadSkillTool = tool({
  description:
    "Load detailed skill documentation when you need specialized knowledge for a task. Skills provide comprehensive workflows, command references, and best practices for specific domains like git operations, testing, deployment, etc.",
  inputSchema,
  execute: executeLoadSkill,
});
