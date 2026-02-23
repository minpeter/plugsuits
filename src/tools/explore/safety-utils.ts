import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";
import {
  computeFileHash,
  formatHashlineNumberedLines,
} from "../utils/hashline/hashline";

const FILE_READ_POLICY = {
  maxFileSizeBytes: 1024 * 1024, // 1MB
  maxLinesPerRead: 2000,
  binarySampleBytes: 4096,
  nonPrintableThreshold: 0.3,
} as const;

const DEFAULT_IGNORED_DIRECTORIES = [
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
  ".venv",
  "venv",
];

const DEFAULT_IGNORED_FILE_PATTERNS = ["*.pyc", ".env.local", ".env.*.local"];

const ignoreCache = new Map<string, Ignore>();

function buildDefaultIgnorePatterns(): string[] {
  return [...DEFAULT_IGNORED_DIRECTORIES, ...DEFAULT_IGNORED_FILE_PATTERNS];
}

export async function getIgnoreFilter(
  baseDir = process.cwd()
): Promise<Ignore> {
  const cacheKey = baseDir;
  const cached = ignoreCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const ig = ignore().add(buildDefaultIgnorePatterns());

  try {
    const gitignorePath = join(baseDir, ".gitignore");
    const gitignoreContent = await readFile(gitignorePath, "utf-8");
    ig.add(gitignoreContent);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // .gitignore doesn't exist, use default patterns only
    } else {
      throw error;
    }
  }

  ignoreCache.set(cacheKey, ig);
  return ig;
}

async function isLikelyBinaryFile(
  filePath: string,
  fileSize: number
): Promise<boolean> {
  if (fileSize === 0) {
    return false;
  }

  const sampleSize = Math.min(FILE_READ_POLICY.binarySampleBytes, fileSize);
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(sampleSize);
    const result = await handle.read(bytes, 0, sampleSize, 0);
    if (result.bytesRead === 0) {
      return false;
    }

    let nonPrintableCount = 0;
    for (let i = 0; i < result.bytesRead; i++) {
      const value = bytes[i];
      if (value === 0) {
        return true;
      }

      if (value < 9 || (value > 13 && value < 32)) {
        nonPrintableCount++;
      }
    }

    return (
      nonPrintableCount / result.bytesRead >
      FILE_READ_POLICY.nonPrintableThreshold
    );
  } finally {
    await handle.close();
  }
}

interface FileCheckResult {
  allowed: boolean;
  reason?: string;
}

interface FileReadGuardContext {
  filePath: string;
  ig: Ignore;
  pathForIgnoreCheck: string | null;
}

type FileReadGuard = (
  context: FileReadGuardContext
) => FileCheckResult | null | Promise<FileCheckResult | null>;

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

const checkIgnoreGuard: FileReadGuard = ({
  filePath,
  ig,
  pathForIgnoreCheck,
}) => {
  if (!(pathForIgnoreCheck && ig.ignores(pathForIgnoreCheck))) {
    return null;
  }

  return {
    allowed: false,
    reason: `File '${filePath}' is excluded by .gitignore. Use glob_files with respect_git_ignore: false if you need to access it.`,
  };
};

const checkFileStatGuards: FileReadGuard = async ({ filePath }) => {
  try {
    const stats = await stat(filePath);

    if (stats.size > FILE_READ_POLICY.maxFileSizeBytes) {
      return {
        allowed: false,
        reason: `File too large (${Math.round(stats.size / 1024)}KB > ${FILE_READ_POLICY.maxFileSizeBytes / 1024}KB): ${filePath}`,
      };
    }

    if (await isLikelyBinaryFile(filePath, stats.size)) {
      return {
        allowed: false,
        reason: `File '${filePath}' is binary. read_file only supports text files. Use appropriate tools for binary content.`,
      };
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      return {
        allowed: false,
        reason: `Unable to inspect file metadata for '${filePath}'.`,
      };
    }
  }

  return null;
};

const FILE_READ_GUARDS: FileReadGuard[] = [
  checkIgnoreGuard,
  checkFileStatGuards,
];

async function checkFileReadable(filePath: string): Promise<FileCheckResult> {
  const ig = await getIgnoreFilter();
  const context: FileReadGuardContext = {
    filePath,
    ig,
    pathForIgnoreCheck: getPathForIgnoreCheck(filePath, process.cwd()),
  };

  for (const guard of FILE_READ_GUARDS) {
    const result = await guard(context);
    if (result) {
      return result;
    }
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
  return formatHashlineNumberedLines(lines, startLine1);
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
  fileHash: string;
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
    const before = Math.max(options.before ?? 5, 0);
    const after = Math.max(options.after ?? 10, 0);
    const clampedAroundLine = Math.min(
      Math.max(options.around_line, 1),
      totalLines
    );
    const window = computeLineWindow({
      aroundLine1: clampedAroundLine,
      before,
      after,
      totalLines,
    });
    startLine1 = window.startLine1;
    endLine1 = window.endLine1;
  } else {
    const offset = Math.max(options?.offset ?? 0, 0);
    const limit = Math.max(
      options?.limit ?? FILE_READ_POLICY.maxLinesPerRead,
      1
    );
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
    fileHash: computeFileHash(rawContent),
  };
}
