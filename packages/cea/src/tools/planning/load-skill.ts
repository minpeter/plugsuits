import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { loadSkillById, type SkillInfo } from "../../context/skills";
import LOAD_SKILL_DESCRIPTION from "./load-skill.txt";

const inputSchema = z.object({
  skillName: z
    .string()
    .describe("Name of the skill to load (e.g., 'git-workflow')"),
  relativePath: z
    .string()
    .optional()
    .describe(
      "Optional: Relative path to file within v2 skill directory (e.g., 'scripts/setup.sh')"
    ),
});

export type LoadSkillInput = z.infer<typeof inputSchema>;

function validateSkillName(skillName: string): string | null {
  if (!skillName || skillName.trim() === "") {
    throw new Error("skillName must be a non-empty string");
  }

  if (skillName.includes("..") || skillName.includes("/")) {
    return `Error: Invalid skill name '${skillName}'. Skill names cannot contain '..' or '/'.`;
  }

  return null;
}

function validateRelativePath(relativePath: string): string | null {
  if (relativePath.includes("..") || isAbsolute(relativePath)) {
    return `Error: Invalid relative path '${relativePath}'. Path must be relative and cannot contain '..'.`;
  }
  return null;
}

async function loadSubFile(
  skillName: string,
  relativePath: string,
  info: SkillInfo & { dirPath: string }
): Promise<string> {
  const fullPath = normalize(join(info.dirPath, relativePath));
  const realSkillDir = await realpath(info.dirPath);
  const realFilePath = await realpath(fullPath).catch(() => fullPath);

  const relativeFromSkillDir = relative(realSkillDir, realFilePath);
  const isWithinSkillDir =
    relativeFromSkillDir === "" ||
    !(
      relativeFromSkillDir.startsWith("..") || isAbsolute(relativeFromSkillDir)
    );

  if (!isWithinSkillDir) {
    return `Error: Path '${relativePath}' resolves outside skill directory. This is not allowed.`;
  }

  try {
    const fileContent = await readFile(realFilePath, "utf-8");
    return `# Skill File: ${skillName}/${relativePath}\n\n${fileContent}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return `Error: File '${relativePath}' not found in skill '${skillName}'.`;
    }
    throw error;
  }
}

function getSourceLabel(source: SkillInfo["source"]): string {
  if (source === "bundled") {
    return "Bundled";
  }
  if (source === "global") {
    return "Global";
  }
  return "Project";
}

export async function executeLoadSkill({
  skillName,
  relativePath,
}: LoadSkillInput): Promise<string> {
  // Validate skill name
  const nameError = validateSkillName(skillName);
  if (nameError) {
    return nameError;
  }

  // Validate relative path if provided
  if (relativePath) {
    const pathError = validateRelativePath(relativePath);
    if (pathError) {
      return pathError;
    }
  }

  try {
    const result = await loadSkillById(skillName);

    if (!result) {
      return `Error: Skill '${skillName}' not found. Available skills can be found in the system prompt.`;
    }

    const { content, info } = result;

    // If relativePath is provided, load that file instead
    if (relativePath) {
      if (info.format !== "v2" || !info.dirPath) {
        return `Error: Skill '${skillName}' is a legacy format skill. Only v2 skills support subdirectory files.`;
      }

      return loadSubFile(
        skillName,
        relativePath,
        info as SkillInfo & { dirPath: string }
      );
    }

    // Load main skill file
    const sourceLabel = getSourceLabel(info.source);
    const formatLabel = info.format === "v2" ? " (v2)" : "";

    return `# Skill Loaded: ${skillName} [${sourceLabel}${formatLabel}]\n\n${content}`;
  } catch (error) {
    return `Error loading skill '${skillName}': ${error instanceof Error ? error.message : String(error)}`;
  }
}

export const loadSkillTool = tool({
  description: LOAD_SKILL_DESCRIPTION,
  inputSchema,
  execute: executeLoadSkill,
});
