import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "glob";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "../skills");

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---/;
const NAME_REGEX = /^name:\s*(.+)$/m;
const DESC_REGEX = /^description:\s*(.+)$/m;
const VERSION_REGEX = /^version:\s*(.+)$/m;
const TRIGGERS_REGEX = /^triggers:\s*\n((?:\s{2}- .+\n?)+)/m;
const LIST_ITEM_REGEX = /^\s*-\s*/;

interface SkillMetadata {
  name: string;
  description: string;
  triggers?: string[];
  version?: string;
}

function parseFrontmatter(content: string): SkillMetadata | null {
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    return null;
  }

  const frontmatter = match[1];
  const metadata: Partial<SkillMetadata> = {};

  const nameMatch = frontmatter.match(NAME_REGEX);
  if (nameMatch) {
    metadata.name = nameMatch[1].trim();
  }

  const descMatch = frontmatter.match(DESC_REGEX);
  if (descMatch) {
    metadata.description = descMatch[1].trim();
  }

  const versionMatch = frontmatter.match(VERSION_REGEX);
  if (versionMatch) {
    metadata.version = versionMatch[1].trim();
  }

  const triggersMatch = frontmatter.match(TRIGGERS_REGEX);
  if (triggersMatch) {
    metadata.triggers = triggersMatch[1]
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.replace(LIST_ITEM_REGEX, "").trim());
  }

  if (!(metadata.name && metadata.description)) {
    return null;
  }

  return metadata as SkillMetadata;
}

export async function loadSkillsMetadata(): Promise<string> {
  try {
    const skillFiles = await glob("*.md", {
      cwd: SKILLS_DIR,
      absolute: false,
    });

    if (skillFiles.length === 0) {
      return "";
    }

    const metadataList = await Promise.all(
      skillFiles.map(async (file) => {
        const filePath = join(SKILLS_DIR, file);
        const content = await readFile(filePath, "utf-8");
        const metadata = parseFrontmatter(content);

        if (!metadata) {
          return null;
        }

        const skillId = file.replace(".md", "");
        return { skillId, metadata };
      })
    );

    const validMetadata = metadataList.filter(
      (item): item is { skillId: string; metadata: SkillMetadata } =>
        item !== null
    );

    if (validMetadata.length === 0) {
      return "";
    }

    const skillDescriptions = validMetadata
      .map(
        ({ skillId, metadata }) =>
          `- **${metadata.name}** (\`${skillId}\`): ${metadata.description}`
      )
      .join("\n");

    return `

## Available Skills

The following specialized skills are available. When you need detailed instructions for a specific workflow, use the \`load_skill\` tool with the skill ID.

${skillDescriptions}

**How to use skills:**
1. Identify which skill matches your current task based on the descriptions above
2. Use \`load_skill\` tool with the skill ID (e.g., \`load_skill("git-workflow")\`)
3. Follow the detailed instructions provided by the skill
`;
  } catch {
    return "";
  }
}
