import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { SkillsEngine } from "@ai-sdk-tool/harness";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = join(__dirname, "../skills");

const skillsEngine = new SkillsEngine({
  bundledDir: BUNDLED_SKILLS_DIR,
  globalSkillsDir: join(homedir(), ".claude", "skills"),
  projectSkillsDir: join(cwd(), ".claude", "skills"),
  globalCommandsDir: join(homedir(), ".claude", "commands"),
  projectCommandsDir: join(cwd(), ".claude", "commands"),
});

export type { SkillInfo } from "@ai-sdk-tool/harness";
export const loadAllSkills = () => skillsEngine.loadAllSkills();
export const loadSkillById = (id: string) => skillsEngine.loadSkillById(id);
export const loadSkillsMetadata = () => skillsEngine.loadSkillsMetadata();
