import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { glob } from "glob";
import { parse as parseYAML } from "yaml";
import { parsePromptsCommandName } from "./skill-command-prefix";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = join(__dirname, "../skills");

// ============================================================================
// Types
// ============================================================================

export interface SkillInfo {
  argumentHint?: string; // For slash commands
  description: string;
  dirPath?: string; // Only for v2 skills
  format: "legacy" | "v2" | "command";
  id: string;
  name: string;
  path: string;
  source:
    | "bundled"
    | "global"
    | "project"
    | "global-command"
    | "project-command";
  version?: string;
}

interface SkillFrontmatter {
  "allowed-tools"?: string;
  "argument-hint"?: string;
  compatibility?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  license?: string;
  metadata?: {
    author?: string;
    version?: string;
    [key: string]: unknown;
  };
  model?: string;
  name?: string;
  triggers?: string[];
  version?: string;
}

// ============================================================================
// Legacy Format (*.md with regex parsing)
// ============================================================================

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---/;
const NAME_REGEX = /^name:\s*(.+)$/m;
const DESC_REGEX = /^description:\s*(.+)$/m;
const VERSION_REGEX = /^version:\s*(.+)$/m;
const TRIGGERS_REGEX = /^triggers:\s*\n((?:\s{2}- .+\n?)+)/m;
const LIST_ITEM_REGEX = /^\s*-\s*/;
const SKILL_NAME_REGEX = /^[a-z0-9-]+$/;
const EXPECTED_SKILL_IO_ERROR_CODES = new Set([
  "EACCES",
  "EISDIR",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);

function getErrnoCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  ) {
    return (error as NodeJS.ErrnoException).code ?? null;
  }
  return null;
}

function isExpectedSkillIoError(error: unknown): boolean {
  const code = getErrnoCode(error);
  return code !== null && EXPECTED_SKILL_IO_ERROR_CODES.has(code);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function warnUnexpectedSkillError(scope: string, error: unknown): void {
  console.warn(`[skills] ${scope}: ${getErrorMessage(error)}`);
}

function parseFrontmatterRegex(content: string): SkillFrontmatter | null {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return null;
  }

  const frontmatter = match[1];
  const metadata: Partial<SkillFrontmatter> = {};

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
  return metadata as SkillFrontmatter;
}

async function loadLegacySkills(
  dirPath: string,
  source: "bundled" | "global" | "project"
): Promise<SkillInfo[]> {
  try {
    const skillFiles = await glob("*.md", { cwd: dirPath, absolute: false });
    if (skillFiles.length === 0) {
      return [];
    }

    const skills = await Promise.all(
      skillFiles.map(async (file) => {
        const filePath = join(dirPath, file);
        try {
          const content = await readFile(filePath, "utf-8");
          const metadata = parseFrontmatterRegex(content);
          if (!metadata) {
            return null;
          }

          const skillId = file.replace(".md", "");
          return {
            id: skillId,
            name: metadata.name,
            description: metadata.description,
            version: metadata.version,
            format: "legacy" as const,
            path: filePath,
            source,
          };
        } catch (error) {
          if (!isExpectedSkillIoError(error)) {
            warnUnexpectedSkillError("loadLegacySkills:file", error);
          }
          return null;
        }
      })
    );

    return skills.filter((skill) => skill !== null) as SkillInfo[];
  } catch (error) {
    if (!isExpectedSkillIoError(error)) {
      warnUnexpectedSkillError("loadLegacySkills:glob", error);
    }
    return [];
  }
}

// ============================================================================
// V2 Format (SKILL.md with YAML parsing)
// ============================================================================

function parseFrontmatterYAML(content: string): SkillFrontmatter | null {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return null;
  }

  try {
    return parseYAML(match[1]) as SkillFrontmatter;
  } catch {
    return null;
  }
}

function validateSkillName(name: string): boolean {
  if (!name || typeof name !== "string") {
    return false;
  }
  if (name.length < 1 || name.length > 64) {
    return false;
  }
  if (!SKILL_NAME_REGEX.test(name)) {
    return false;
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    return false;
  }
  return true;
}

function isSkillDirectory(dirPath: string): boolean {
  return existsSync(join(dirPath, "SKILL.md"));
}

async function discoverSkillDirectories(searchPath: string): Promise<string[]> {
  try {
    const entries = await readdir(searchPath, { withFileTypes: true });
    const skillDirs: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = join(searchPath, entry.name);
        if (isSkillDirectory(dirPath)) {
          skillDirs.push(dirPath);
        }
      }
    }

    return skillDirs;
  } catch (error) {
    if (!isExpectedSkillIoError(error)) {
      warnUnexpectedSkillError("discoverSkillDirectories", error);
    }
    return [];
  }
}

async function loadSkillV2(
  dirPath: string,
  source: "bundled" | "global" | "project"
): Promise<SkillInfo | null> {
  try {
    const skillPath = join(dirPath, "SKILL.md");
    const content = await readFile(skillPath, "utf-8");
    const frontmatter = parseFrontmatterYAML(content);

    if (!(frontmatter?.name && frontmatter.description)) {
      return null;
    }

    const dirName = basename(dirPath);
    if (!validateSkillName(frontmatter.name)) {
      return null;
    }
    if (frontmatter.name !== dirName) {
      return null;
    }
    if (frontmatter.description.length > 1024) {
      return null;
    }

    return {
      id: frontmatter.name,
      name: frontmatter.name,
      description: frontmatter.description,
      version: frontmatter.metadata?.version || frontmatter.version,
      format: "v2",
      path: skillPath,
      dirPath,
      source,
    };
  } catch (error) {
    if (!isExpectedSkillIoError(error)) {
      warnUnexpectedSkillError("loadSkillV2", error);
    }
    return null;
  }
}

async function loadV2Skills(
  bundledPath: string,
  projectPath?: string
): Promise<SkillInfo[]> {
  const globalPath = join(homedir(), ".claude", "skills");

  const [projectDirs, globalDirs, bundledDirs] = await Promise.all([
    projectPath ? discoverSkillDirectories(projectPath) : Promise.resolve([]),
    discoverSkillDirectories(globalPath),
    discoverSkillDirectories(bundledPath),
  ]);

  const [projectSkills, globalSkills, bundledSkills] = await Promise.all([
    Promise.all(projectDirs.map((dir) => loadSkillV2(dir, "project"))),
    Promise.all(globalDirs.map((dir) => loadSkillV2(dir, "global"))),
    Promise.all(bundledDirs.map((dir) => loadSkillV2(dir, "bundled"))),
  ]);

  const allSkills = [
    ...projectSkills.filter((s): s is SkillInfo => s !== null),
    ...globalSkills.filter((s): s is SkillInfo => s !== null),
    ...bundledSkills.filter((s): s is SkillInfo => s !== null),
  ];

  // Deduplicate by ID and real path (symlink detection)
  const seen = new Map<string, SkillInfo>();
  const seenRealPaths = new Set<string>();
  const realpathCache = new Map<string, string>();

  for (const skill of allSkills) {
    if (!skill.dirPath) {
      seen.set(skill.id, skill);
      continue;
    }

    // Resolve real path for symlink detection
    let realPath: string;
    try {
      const cached = realpathCache.get(skill.dirPath);
      if (cached) {
        realPath = cached;
      } else {
        realPath = await realpath(skill.dirPath);
        realpathCache.set(skill.dirPath, realPath);
      }
    } catch (error) {
      if (!isExpectedSkillIoError(error)) {
        warnUnexpectedSkillError("loadV2Skills:realpath", error);
      }
      realPath = skill.dirPath;
    }

    if (seenRealPaths.has(realPath)) {
      continue;
    }
    seenRealPaths.add(realPath);

    const existing = seen.get(skill.id);
    if (!existing) {
      seen.set(skill.id, skill);
      continue;
    }

    // Priority: project > global > bundled (commands have lower priority)
    const priority: Record<SkillInfo["source"], number> = {
      project: 5,
      global: 4,
      bundled: 3,
      "project-command": 2,
      "global-command": 1,
    };
    if (priority[skill.source] > priority[existing.source]) {
      seen.set(skill.id, skill);
    }
  }

  return Array.from(seen.values());
}

// ============================================================================
// Slash Commands (*.md files in commands directories)
// ============================================================================

interface SlashCommandInfo {
  argumentHint?: string;
  description: string;
  id: string;
  name: string;
  path: string;
  source: "global-command" | "project-command";
}

async function loadSlashCommands(
  dirPath: string,
  source: "global-command" | "project-command"
): Promise<SlashCommandInfo[]> {
  try {
    // Find all .md files including subdirectories
    const commandFiles = await glob("**/*.md", {
      cwd: dirPath,
      absolute: false,
      nodir: true,
    });

    if (commandFiles.length === 0) {
      return [];
    }

    const commands = await Promise.all(
      commandFiles.map(async (file) => {
        const filePath = join(dirPath, file);
        try {
          const content = await readFile(filePath, "utf-8");

          // Parse frontmatter with YAML
          const frontmatter = parseFrontmatterYAML(content);

          // Command ID is filename without .md extension
          // Subdirectory is used for namespacing but not part of the ID
          const commandId = basename(file, ".md");

          // Use description from frontmatter, or generate from filename
          const description =
            frontmatter?.description || `Slash command: ${commandId}`;

          return {
            id: commandId,
            name: frontmatter?.name || commandId,
            description,
            path: filePath,
            source,
            argumentHint: frontmatter?.["argument-hint"],
          } as SlashCommandInfo;
        } catch (error) {
          if (!isExpectedSkillIoError(error)) {
            warnUnexpectedSkillError("loadSlashCommands:file", error);
          }
          return null;
        }
      })
    );

    return commands.filter((cmd): cmd is SlashCommandInfo => cmd !== null);
  } catch (error) {
    if (!isExpectedSkillIoError(error)) {
      warnUnexpectedSkillError("loadSlashCommands:glob", error);
    }
    return [];
  }
}

async function loadAllSlashCommands(): Promise<SkillInfo[]> {
  const globalCommandsPath = join(homedir(), ".claude", "commands");
  const projectCommandsPath = join(cwd(), ".claude", "commands");

  const [globalCommands, projectCommands] = await Promise.all([
    loadSlashCommands(globalCommandsPath, "global-command"),
    loadSlashCommands(projectCommandsPath, "project-command"),
  ]);

  // Convert to SkillInfo format
  const toSkillInfo = (cmd: SlashCommandInfo): SkillInfo => ({
    id: cmd.id,
    name: cmd.name,
    description: cmd.description,
    format: "command",
    path: cmd.path,
    source: cmd.source,
    argumentHint: cmd.argumentHint,
  });

  // Project commands take priority over global commands with same ID
  const commandsMap = new Map<string, SkillInfo>();

  for (const cmd of globalCommands) {
    commandsMap.set(cmd.id, toSkillInfo(cmd));
  }

  for (const cmd of projectCommands) {
    commandsMap.set(cmd.id, toSkillInfo(cmd));
  }

  return Array.from(commandsMap.values());
}

// ============================================================================
// Public API
// ============================================================================

export async function loadAllSkills(): Promise<SkillInfo[]> {
  const projectSkillsPath = join(cwd(), ".claude", "skills");
  const globalSkillsPath = join(homedir(), ".claude", "skills");

  const [bundledLegacy, globalLegacy, projectLegacy, v2Skills, slashCommands] =
    await Promise.all([
      loadLegacySkills(BUNDLED_SKILLS_DIR, "bundled"),
      loadLegacySkills(globalSkillsPath, "global"),
      loadLegacySkills(projectSkillsPath, "project"),
      loadV2Skills(BUNDLED_SKILLS_DIR, projectSkillsPath),
      loadAllSlashCommands(),
    ]);

  const allLegacy = [...bundledLegacy, ...globalLegacy, ...projectLegacy];
  const skillsMap = new Map<string, SkillInfo>();

  // Add slash commands first (lowest priority)
  for (const cmd of slashCommands) {
    skillsMap.set(cmd.id, cmd);
  }

  // Add legacy skills (overrides commands with same ID)
  for (const skill of allLegacy) {
    skillsMap.set(skill.id, skill);
  }

  // Add v2 skills (v2 takes priority over legacy if same ID)
  for (const skill of v2Skills) {
    skillsMap.set(skill.id, skill);
  }

  return Array.from(skillsMap.values());
}

export async function loadSkillById(
  skillId: string
): Promise<{ content: string; info: SkillInfo } | null> {
  const allSkills = await loadAllSkills();

  const promptsSkillId = parsePromptsCommandName(skillId);
  const skill = promptsSkillId
    ? allSkills.find((s) => s.id === promptsSkillId)
    : allSkills.find((s) => s.id === skillId);

  if (!skill) {
    return null;
  }

  try {
    const content = await readFile(skill.path, "utf-8");
    return { content, info: skill };
  } catch (error) {
    if (!isExpectedSkillIoError(error)) {
      warnUnexpectedSkillError("loadSkillById", error);
    }
    return null;
  }
}

export async function loadSkillsMetadata(): Promise<string> {
  try {
    const skills = await loadAllSkills();
    if (skills.length === 0) {
      return "";
    }

    const skillDescriptions = skills
      .map(
        (skill) => `- **${skill.name}** (\`${skill.id}\`): ${skill.description}`
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
  } catch (error) {
    warnUnexpectedSkillError("loadSkillsMetadata", error);
    return "";
  }
}
