import type { Dirent } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ignore from "ignore";
import {
  computeFileHash,
  formatHashlineNumberedLines,
} from "./hashline/hashline";

const FILE_READ_POLICY = {
  maxFileSizeBytes: 1024 * 1024, // 1MB
  maxLinesPerRead: 2000,
  binarySampleBytes: 4096,
  nonPrintableThreshold: 0.3,
} as const;

const LEADING_DOT_SLASH_PATTERN = /^\.\//;
const MULTIPLE_SLASH_PATTERN = /\/+/g;
const LINE_SPLIT_PATTERN = /\r?\n/;
const PATH_SEGMENT_SPLIT_PATTERN = /[\\/]/;

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;

const DEFAULT_IGNORED_DIRECTORIES = [
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  ".pnpm-store",
  ".npm",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "bin",
  "obj",
  "coverage",
  "logs",
  "tmp",
  "temp",
  ".cache",
  ".turbo",
  ".vercel",
  ".output",
  ".gradle",
  ".history",
  "__pycache__",
  ".venv",
  "venv",
];

const DEFAULT_IGNORED_FILE_PATTERNS = [
  "*.pyc",
  "*.swp",
  "*.swo",
  "*.log",
  ".env.local",
  ".env.*.local",
];

const DEFAULT_IGNORED_DIRECTORY_SET = new Set(DEFAULT_IGNORED_DIRECTORIES);
const IGNORE_FILE_NAME_SET = new Set<string>(IGNORE_FILE_NAMES);

export interface IgnoreFilter {
  ignores: (pathFromBaseDir: string) => boolean;
}

function buildDefaultIgnorePatterns(): string[] {
  return [...DEFAULT_IGNORED_DIRECTORIES, ...DEFAULT_IGNORED_FILE_PATTERNS];
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function toPosixPath(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

function normalizePathForIgnore(pathValue: string): string {
  return toPosixPath(pathValue)
    .replace(LEADING_DOT_SLASH_PATTERN, "")
    .replace(MULTIPLE_SLASH_PATTERN, "/");
}

function shouldIgnoreReadError(error: unknown): boolean {
  return (
    isErrnoException(error) &&
    (error.code === "ENOENT" || error.code === "EACCES")
  );
}

function prefixIgnorePattern(line: string, prefix: string): string[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) {
    return [];
  }

  let pattern = trimmed;
  let negated = false;

  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }

  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }

  const prefixedPattern = prefix ? `${prefix}${pattern}` : pattern;
  const patterns = [prefixedPattern];

  if (prefix.length > 0 && !pattern.includes("/")) {
    patterns.push(`${prefix}**/${pattern}`);
  }

  if (!negated) {
    return patterns;
  }

  return patterns.map((candidatePattern) => `!${candidatePattern}`);
}

async function readIgnoreFilePatterns(params: {
  ignoreFilePath: string;
  prefix: string;
}): Promise<string[]> {
  const { ignoreFilePath, prefix } = params;
  try {
    const content = await readFile(ignoreFilePath, "utf-8");
    return content
      .split(LINE_SPLIT_PATTERN)
      .flatMap((line) => prefixIgnorePattern(line, prefix));
  } catch (error) {
    if (shouldIgnoreReadError(error)) {
      return [];
    }
    throw error;
  }
}

async function findGitRoot(startDir: string): Promise<string | null> {
  let currentDir = resolve(startDir);
  while (true) {
    try {
      await stat(join(currentDir, ".git"));
      return currentDir;
    } catch (error) {
      if (!(isErrnoException(error) && error.code === "ENOENT")) {
        throw error;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function buildDirectoryChain(rootDir: string, leafDir: string): string[] {
  const resolvedRoot = resolve(rootDir);
  const resolvedLeaf = resolve(leafDir);
  const relativePath = relative(resolvedRoot, resolvedLeaf);

  if (
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    relativePath.length === 0
  ) {
    return [resolvedLeaf];
  }

  const segments = relativePath
    .split(PATH_SEGMENT_SPLIT_PATTERN)
    .filter((segment) => segment.length > 0);
  const chain = [resolvedRoot];
  let cursor = resolvedRoot;

  for (const segment of segments) {
    cursor = join(cursor, segment);
    chain.push(cursor);
  }

  return chain;
}

function getPathDepth(pathValue: string): number {
  return resolve(pathValue)
    .split(PATH_SEGMENT_SPLIT_PATTERN)
    .filter((segment) => segment.length > 0).length;
}

function shouldSkipDirectoryTraversal(directoryName: string): boolean {
  return DEFAULT_IGNORED_DIRECTORY_SET.has(directoryName);
}

async function readDirectoryEntries(
  pathValue: string
): Promise<Dirent[] | null> {
  try {
    return await readdir(pathValue, { withFileTypes: true });
  } catch (error) {
    if (shouldIgnoreReadError(error)) {
      return null;
    }
    throw error;
  }
}

async function collectNestedIgnoreDirectories(
  baseDir: string
): Promise<string[]> {
  const resolvedBaseDir = resolve(baseDir);
  const discovered = new Set<string>();
  const stack = [resolvedBaseDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    const entries = await readDirectoryEntries(currentDir);
    if (!entries) {
      continue;
    }

    const hasIgnoreFile = entries.some((entry) => {
      return entry.isFile() && IGNORE_FILE_NAME_SET.has(entry.name);
    });
    if (hasIgnoreFile) {
      discovered.add(currentDir);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (shouldSkipDirectoryTraversal(entry.name)) {
        continue;
      }

      stack.push(join(currentDir, entry.name));
    }
  }

  return Array.from(discovered);
}

async function buildIgnoreMatcher(baseDir: string): Promise<{
  basePrefixFromRoot: string;
  matcher: ReturnType<typeof ignore>;
}> {
  const resolvedBaseDir = resolve(baseDir);
  const ignoreRootDir = (await findGitRoot(resolvedBaseDir)) ?? resolvedBaseDir;

  const directories = new Set<string>(
    buildDirectoryChain(ignoreRootDir, resolvedBaseDir)
  );
  const nestedDirectories =
    await collectNestedIgnoreDirectories(resolvedBaseDir);
  for (const dir of nestedDirectories) {
    directories.add(dir);
  }

  const orderedDirectories = Array.from(directories).sort((left, right) => {
    const depthDiff = getPathDepth(left) - getPathDepth(right);
    if (depthDiff !== 0) {
      return depthDiff;
    }
    return left.localeCompare(right);
  });

  const patterns: string[] = [];
  for (const dir of orderedDirectories) {
    const relativeDir = relative(ignoreRootDir, dir);
    const normalizedPrefix =
      relativeDir.length > 0 && relativeDir !== "."
        ? `${toPosixPath(relativeDir)}/`
        : "";

    for (const fileName of IGNORE_FILE_NAMES) {
      const ignoreFilePath = join(dir, fileName);
      const filePatterns = await readIgnoreFilePatterns({
        ignoreFilePath,
        prefix: normalizedPrefix,
      });
      patterns.push(...filePatterns);
    }
  }

  const gitInfoExcludePatterns = await readIgnoreFilePatterns({
    ignoreFilePath: join(ignoreRootDir, ".git", "info", "exclude"),
    prefix: "",
  });
  patterns.push(...gitInfoExcludePatterns);

  const matcher = ignore().add(buildDefaultIgnorePatterns()).add(patterns);
  const baseRelativeFromRoot = relative(ignoreRootDir, resolvedBaseDir);
  const basePrefixFromRoot =
    baseRelativeFromRoot.length > 0 && baseRelativeFromRoot !== "."
      ? `${toPosixPath(baseRelativeFromRoot)}/`
      : "";

  return { basePrefixFromRoot, matcher };
}

export async function getIgnoreFilter(
  baseDir = process.cwd()
): Promise<IgnoreFilter> {
  const { basePrefixFromRoot, matcher } = await buildIgnoreMatcher(baseDir);
  return {
    ignores(pathFromBaseDir: string): boolean {
      const normalizedPath = normalizePathForIgnore(pathFromBaseDir);
      if (normalizedPath.length === 0) {
        return false;
      }

      const pathForMatcher = basePrefixFromRoot
        ? `${basePrefixFromRoot}${normalizedPath}`
        : normalizedPath;
      return matcher.ignores(pathForMatcher);
    },
  };
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
  lastModified?: string;
  reason?: string;
}

interface FileReadGuardContext {
  filePath: string;
  ig: IgnoreFilter;
  lastModified: string;
  pathForIgnoreCheck: string | null;
  resolvedFilePath: string;
  respectGitIgnore: boolean;
}

type FileReadGuard = (
  context: FileReadGuardContext
) => FileCheckResult | null | Promise<FileCheckResult | null>;

function getPathForIgnoreCheck(
  filePath: string,
  baseDir: string
): string | null {
  const absolutePath = isAbsolute(filePath)
    ? filePath
    : join(baseDir, filePath);
  const relativePath = relative(baseDir, absolutePath);
  const isInsideBaseDir = !(
    relativePath.startsWith("..") || isAbsolute(relativePath)
  );

  if (!isInsideBaseDir) {
    return null;
  }

  return normalizePathForIgnore(relativePath);
}

const checkIgnoreGuard: FileReadGuard = ({
  filePath,
  ig,
  pathForIgnoreCheck,
  respectGitIgnore,
}) => {
  if (!respectGitIgnore) {
    return null;
  }

  if (!(pathForIgnoreCheck && ig.ignores(pathForIgnoreCheck))) {
    return null;
  }

  return {
    allowed: false,
    reason: `File '${filePath}' is excluded by ignore rules (.gitignore/.ignore/.fdignore or fallback safety patterns). Set respect_git_ignore: false to bypass for this read.`,
  };
};

const checkFileStatGuards: FileReadGuard = async (context) => {
  const { filePath, resolvedFilePath } = context;
  try {
    const stats = await stat(resolvedFilePath);
    context.lastModified = stats.mtime.toISOString();

    if (stats.size > FILE_READ_POLICY.maxFileSizeBytes) {
      return {
        allowed: false,
        reason: `File too large (${Math.round(stats.size / 1024)}KB > ${FILE_READ_POLICY.maxFileSizeBytes / 1024}KB): ${filePath}`,
      };
    }

    if (await isLikelyBinaryFile(resolvedFilePath, stats.size)) {
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

async function checkFileReadable(
  filePath: string,
  options?: {
    respectGitIgnore?: boolean;
  }
): Promise<FileCheckResult> {
  const cwd = process.cwd();
  const resolvedFilePath = isAbsolute(filePath)
    ? filePath
    : resolve(cwd, filePath);
  const insideCwd = getPathForIgnoreCheck(resolvedFilePath, cwd) !== null;
  const baseDir = insideCwd ? cwd : dirname(resolvedFilePath);

  const ig = await getIgnoreFilter(baseDir);
  const context: FileReadGuardContext = {
    filePath,
    resolvedFilePath,
    ig,
    lastModified: "unknown",
    pathForIgnoreCheck: getPathForIgnoreCheck(resolvedFilePath, baseDir),
    respectGitIgnore: options?.respectGitIgnore ?? true,
  };

  for (const guard of FILE_READ_GUARDS) {
    const result = await guard(context);
    if (result) {
      return result;
    }
  }

  return { allowed: true, lastModified: context.lastModified };
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
  lastModified: string;
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
    respect_git_ignore?: boolean;
  }
): Promise<ReadFileResultEnhanced> {
  const check = await checkFileReadable(path, {
    respectGitIgnore: options?.respect_git_ignore,
  });
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
    lastModified: check.lastModified ?? "unknown",
  };
}
