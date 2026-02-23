import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
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

function isBinaryFile(path: string): boolean {
  const ext = path.toLowerCase().slice(path.lastIndexOf("."));
  return BINARY_EXTENSIONS.has(ext);
}

interface FileCheckResult {
  allowed: boolean;
  reason?: string;
}

function getPathForIgnoreCheck(filePath: string, cwd: string): string | null {
  if (isAbsolute(filePath)) {
    const relativePath = relative(cwd, filePath);
    const isInsideProject = !(
      relativePath.startsWith("..") || isAbsolute(relativePath)
    );
    return isInsideProject ? relativePath : null;
  }
  return filePath;
}

async function checkFileReadable(filePath: string): Promise<FileCheckResult> {
  const ig = await getIgnoreFilter();
  const pathForIgnoreCheck = getPathForIgnoreCheck(filePath, process.cwd());

  if (pathForIgnoreCheck && ig.ignores(pathForIgnoreCheck)) {
    return {
      allowed: false,
      reason: `File '${filePath}' is excluded by .gitignore. Use glob_files with respect_git_ignore: false if you need to access it.`,
    };
  }

  if (isBinaryFile(filePath)) {
    return {
      allowed: false,
      reason: `File '${filePath}' is binary. read_file only supports text files. Use appropriate tools for binary content.`,
    };
  }

  try {
    const stats = await stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      return {
        allowed: false,
        reason: `File too large (${Math.round(stats.size / 1024)}KB > ${MAX_FILE_SIZE / 1024}KB): ${filePath}`,
      };
    }
  } catch {
    // stat failed - let the actual read operation handle this
  }

  return { allowed: true };
}

export interface ReadFileOptions {
  limit?: number;
  offset?: number;
}

export function formatNumberedLines(
  lines: string[],
  startLine1: number
): string {
  return lines
    .map((line, i) => {
      const lineNum = startLine1 + i;
      return `  ${String(lineNum).padStart(4)} | ${line}`;
    })
    .join("\n");
}

export function formatBlock(title: string, body: string): string {
  return `======== ${title} ========\n${body}\n======== end ========`;
}

export interface LineWindow {
  endLine1: number;
  startLine1: number;
}

export function computeLineWindow(params: {
  aroundLine1: number;
  before: number;
  after: number;
  totalLines: number;
}): LineWindow {
  const { aroundLine1, before, after, totalLines } = params;
  const startLine1 = Math.max(1, aroundLine1 - before);
  const endLine1 = Math.min(totalLines, aroundLine1 + after);
  return { startLine1, endLine1 };
}

export interface ReadFileResultEnhanced {
  bytes: number;
  content: string;
  endLine1: number;
  numberedContent: string;
  startLine1: number;
  totalLines: number;
  truncated: boolean;
}

export async function safeReadFileEnhanced(
  path: string,
  options?: ReadFileOptions & {
    around_line?: number;
    before?: number;
    after?: number;
  }
): Promise<ReadFileResultEnhanced> {
  const check = await checkFileReadable(path);
  if (!check.allowed) {
    throw new Error(check.reason);
  }

  const rawContent = await readFile(path, "utf-8");
  const allLines = rawContent.split("\n");
  const totalLines = allLines.length;
  const bytes = Buffer.byteLength(rawContent, "utf-8");

  let startLine1: number;
  let endLine1: number;

  if (options?.around_line !== undefined) {
    const before = options.before ?? 5;
    const after = options.after ?? 10;
    const window = computeLineWindow({
      aroundLine1: options.around_line,
      before,
      after,
      totalLines,
    });
    startLine1 = window.startLine1;
    endLine1 = window.endLine1;
  } else {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? MAX_LINES;
    startLine1 = Math.min(offset + 1, totalLines);
    endLine1 = Math.min(offset + limit, totalLines);
  }

  const selectedLines = allLines.slice(startLine1 - 1, endLine1);
  const truncated = endLine1 < totalLines || startLine1 > 1;

  return {
    content: selectedLines.join("\n"),
    numberedContent: formatNumberedLines(selectedLines, startLine1),
    totalLines,
    startLine1,
    endLine1,
    truncated,
    bytes,
  };
}
