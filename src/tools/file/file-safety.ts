import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_LINES = 2000;
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".bmp",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".mkv",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".db",
  ".sqlite",
  ".lock",
]);

const DEFAULT_IGNORE_PATTERNS = [
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  ".vercel",
  ".output",
  "__pycache__",
  "*.pyc",
  ".venv",
  "venv",
  ".env.local",
  ".env.*.local",
];

let cachedIgnore: Ignore | null = null;

export async function getIgnoreFilter(): Promise<Ignore> {
  if (cachedIgnore) {
    return cachedIgnore;
  }

  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS);

  try {
    const gitignorePath = join(process.cwd(), ".gitignore");
    const gitignoreContent = await readFile(gitignorePath, "utf-8");
    ig.add(gitignoreContent);
  } catch {
    // .gitignore doesn't exist, use default patterns only
  }

  cachedIgnore = ig;
  return ig;
}

export function isBinaryFile(path: string): boolean {
  const ext = path.toLowerCase().slice(path.lastIndexOf("."));
  return BINARY_EXTENSIONS.has(ext);
}

export interface FileCheckResult {
  allowed: boolean;
  reason?: string;
}

export async function checkFileReadable(
  path: string
): Promise<FileCheckResult> {
  const ig = await getIgnoreFilter();

  if (ig.ignores(path)) {
    return { allowed: false, reason: `File is ignored by .gitignore: ${path}` };
  }

  if (isBinaryFile(path)) {
    return { allowed: false, reason: `Binary file cannot be read: ${path}` };
  }

  try {
    const stats = await stat(path);
    if (stats.size > MAX_FILE_SIZE) {
      return {
        allowed: false,
        reason: `File too large (${Math.round(stats.size / 1024)}KB > ${MAX_FILE_SIZE / 1024}KB): ${path}`,
      };
    }
  } catch {
    // File doesn't exist, let the read operation handle this
  }

  return { allowed: true };
}

export interface ReadFileOptions {
  offset?: number;
  limit?: number;
}

export interface ReadFileResult {
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export async function safeReadFile(
  path: string,
  options?: ReadFileOptions
): Promise<ReadFileResult> {
  const check = await checkFileReadable(path);
  if (!check.allowed) {
    throw new Error(check.reason);
  }

  const content = await readFile(path, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? MAX_LINES;

  const startLine = Math.min(offset, totalLines);
  const endLine = Math.min(startLine + limit, totalLines);
  const selectedLines = lines.slice(startLine, endLine);
  const truncated = endLine < totalLines;

  return {
    content: selectedLines.join("\n"),
    totalLines,
    startLine,
    endLine,
    truncated,
  };
}

export async function shouldIgnorePath(path: string): Promise<boolean> {
  const ig = await getIgnoreFilter();
  return ig.ignores(path);
}

export function clearIgnoreCache(): void {
  cachedIgnore = null;
}

const WHITESPACE_REGEX = /\s+/;

const ALLOWED_COMMANDS = new Set([
  "node",
  "npm",
  "pnpm",
  "yarn",
  "git",
  "ls",
  "pwd",
  "echo",
  "cat",
  "head",
  "tail",
  "wc",
  "which",
  "find",
  "type",
  "dir",
  "ps",
  "df",
  "du",
  "free",
  "uname",
  "uptime",
  "date",
  "cal",
]);

export function isSafeCommand(command: string): boolean {
  const tokens = command.trim().split(WHITESPACE_REGEX);
  const commandName = tokens[0];
  return ALLOWED_COMMANDS.has(commandName.toLowerCase());
}
