import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";

interface EditResult {
  startLine: number;
  endLine: number;
  context: string;
}

interface SimilarStringCandidate {
  text: string;
  lineNumber: number;
  similarity: number;
  context: string;
}

interface FileIssues {
  hasNonAscii: boolean;
  hasCRLF: boolean;
  hasReplacementChar: boolean;
  nonAsciiCount: number;
}

function escapeUnicode(str: string): string {
  return str
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code > 127) {
        return `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
      }
      return char;
    })
    .join("");
}

function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;

  if (Math.abs(len1 - len2) > Math.max(len1, len2) * 0.7) {
    return Math.max(len1, len2);
  }

  const matrix: number[][] = new Array(len1 + 1)
    .fill(null)
    .map(() => new Array(len2 + 1).fill(0));

  for (let i = 0; i <= len1; i++) {
    matrix[i][0] = i;
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[len1][len2];
}

function calculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) {
    return 100;
  }
  if (str1.length === 0 || str2.length === 0) {
    return 0;
  }

  const distance = levenshteinDistance(str1, str2);
  const maxLen = Math.max(str1.length, str2.length);
  const similarity = ((maxLen - distance) / maxLen) * 100;

  return Math.max(0, Math.min(100, similarity));
}

function extractLineContext(
  lines: string[],
  lineIdx: number,
  contextLines: number
): string {
  const start = Math.max(0, lineIdx - contextLines);
  const end = Math.min(lines.length - 1, lineIdx + contextLines);

  return lines
    .slice(start, end + 1)
    .map((line, idx) => {
      const actualLineNum = start + idx + 1;
      const marker = actualLineNum === lineIdx + 1 ? ">" : " ";
      return `${marker} ${actualLineNum.toString().padStart(4)} | ${line}`;
    })
    .join("\n");
}

function findSimilarStrings(
  content: string,
  searchStr: string,
  options: {
    threshold?: number;
    maxResults?: number;
    contextLines?: number;
  } = {}
): SimilarStringCandidate[] {
  const { threshold = 50, maxResults = 3, contextLines = 2 } = options;

  const lines = content.split("\n");
  const candidates: SimilarStringCandidate[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    const lineSimilarity = calculateSimilarity(line, searchStr);
    if (lineSimilarity >= threshold) {
      candidates.push({
        text: line,
        lineNumber: lineIdx + 1,
        similarity: Math.round(lineSimilarity),
        context: extractLineContext(lines, lineIdx, contextLines),
      });
    }

    const minLen = Math.max(1, searchStr.length - 5);
    const maxLen = searchStr.length + 5;

    for (let start = 0; start < line.length; start++) {
      for (
        let len = minLen;
        len <= maxLen && start + len <= line.length;
        len++
      ) {
        const substring = line.slice(start, start + len);
        const similarity = calculateSimilarity(substring, searchStr);

        if (similarity >= threshold) {
          candidates.push({
            text: substring,
            lineNumber: lineIdx + 1,
            similarity: Math.round(similarity),
            context: extractLineContext(lines, lineIdx, contextLines),
          });
        }
      }
    }
  }

  return candidates
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxResults)
    .filter(
      (candidate, index, self) =>
        index === self.findIndex((c) => c.text === candidate.text)
    );
}

function hasNonAsciiChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) {
      return true;
    }
  }
  return false;
}

function countNonAsciiChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) {
      count++;
    }
  }
  return count;
}

function detectFileIssues(content: string): FileIssues {
  const hasNonAscii = hasNonAsciiChars(content);
  const hasCRLF = content.includes("\r\n");
  const hasReplacementChar = content.includes("\uFFFD");
  const nonAsciiCount = countNonAsciiChars(content);

  return {
    hasNonAscii,
    hasCRLF,
    hasReplacementChar,
    nonAsciiCount,
  };
}

function buildEnhancedErrorMessage(oldStr: string, content: string): string {
  const issues = detectFileIssues(content);
  const candidates = findSimilarStrings(content, oldStr, {
    threshold: 40,
    maxResults: 3,
    contextLines: 2,
  });

  let errorMsg = "old_str not found in file\n\n";
  errorMsg += "SEARCH TARGET (escaped):\n";
  errorMsg += `  old_str = "${escapeUnicode(oldStr)}"\n`;
  errorMsg += `  Length: ${oldStr.length} characters\n`;

  if (oldStr.length <= 20) {
    const bytes = Array.from(oldStr)
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join(" ");
    errorMsg += `  Bytes (hex): ${bytes}\n`;
  }

  errorMsg += "\n❌ This exact string was not found in the file.\n";

  if (candidates.length > 0) {
    errorMsg +=
      "\n🔍 SIMILAR STRINGS FOUND (you might be looking for one of these):\n";

    candidates.forEach((candidate, idx) => {
      errorMsg += `\n${idx + 1}. Line ${candidate.lineNumber} (${candidate.similarity}% similar):\n`;
      errorMsg += `   Visual: "${candidate.text}"\n`;
      errorMsg += `   Escaped: "${escapeUnicode(candidate.text)}"\n`;
      errorMsg += "\n   Context:\n";
      errorMsg += candidate.context
        .split("\n")
        .map((line) => `   ${line}`)
        .join("\n");
      errorMsg += "\n";
    });

    errorMsg += "\n💡 SUGGESTION:\n";
    errorMsg += "   Use one of the escaped strings above as your old_str.\n";
    errorMsg += "   Example:\n";
    errorMsg += `     old_str = "${escapeUnicode(candidates[0].text)}"\n`;
  }

  if (issues.hasNonAscii || issues.hasCRLF || issues.hasReplacementChar) {
    errorMsg += "\n⚠️  FILE DIAGNOSTICS:\n";
    if (issues.hasNonAscii) {
      errorMsg += `   • Non-ASCII characters: ${issues.nonAsciiCount} found\n`;
    }
    if (issues.hasReplacementChar) {
      errorMsg +=
        "   • Replacement characters (�): YES (possible encoding corruption)\n";
    }
    if (issues.hasCRLF) {
      errorMsg += "   • Line endings: CRLF (Windows-style)\n";
    } else {
      errorMsg += "   • Line endings: LF (Unix-style)\n";
    }
  }

  errorMsg += "\n📋 RECOVERY STRATEGIES:\n";
  errorMsg += "   1. Re-run read_file to see the exact file content\n";
  errorMsg += `   2. Copy the EXACT text from read_file output (don't guess)\n`;
  errorMsg +=
    "   3. If edit_file keeps failing, use write_file to rewrite the entire file\n";

  return errorMsg;
}

function extractEditContext(
  content: string,
  editStartIndex: number,
  newStr: string,
  contextLines = 2
): EditResult {
  const lines = content.split("\n");
  const beforeEdit = content.slice(0, editStartIndex);
  const startLine = beforeEdit.split("\n").length;

  const newStrLines = newStr.split("\n");
  const endLine = startLine + newStrLines.length - 1;

  const contextStart = Math.max(1, startLine - contextLines);
  const contextEnd = Math.min(lines.length, endLine + contextLines);

  const contextSnippet = lines
    .slice(contextStart - 1, contextEnd)
    .map((line, i) => {
      const lineNum = contextStart + i;
      const isEdited = lineNum >= startLine && lineNum <= endLine;
      const prefix = isEdited ? ">" : " ";
      return `${prefix} ${String(lineNum).padStart(4)} | ${line}`;
    })
    .join("\n");

  return {
    startLine,
    endLine,
    context: contextSnippet,
  };
}

function formatEditResult(filePath: string, results: EditResult[]): string {
  const fileName = basename(filePath);
  const output: string[] = [];

  for (const result of results) {
    output.push(
      `======== ${fileName} L${result.startLine}-L${result.endLine} ========`
    );
    output.push(result.context);
    output.push("======== end ========");
  }

  return output.join("\n");
}

const inputSchema = z.object({
  path: z.string().describe("The path to the file"),
  old_str: z
    .string()
    .describe(
      "Text to search for - must match exactly. " +
        "By default, must have exactly one match unless replace_all is true."
    ),
  new_str: z.string().describe("Text to replace old_str with"),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, replace all occurrences of old_str. " +
        "If false (default), old_str must match exactly once."
    ),
});

export type EditFileInput = z.infer<typeof inputSchema>;

async function handleFileCreation(
  filePath: string,
  content: string
): Promise<string> {
  const dir = dirname(filePath);
  if (dir !== ".") {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(filePath, content, "utf-8");
  return `Successfully created file ${filePath}`;
}

interface ReplaceResult {
  newContent: string;
  replacementCount: number;
  editResults: EditResult[];
}

function performReplaceAll(
  content: string,
  oldStr: string,
  newStr: string
): ReplaceResult {
  const matchPositions: number[] = [];
  let pos = content.indexOf(oldStr);
  while (pos !== -1) {
    matchPositions.push(pos);
    pos = content.indexOf(oldStr, pos + 1);
  }

  let newContent = content;
  let offset = 0;
  const editResults: EditResult[] = [];

  for (const originalPos of matchPositions) {
    const adjustedPos = originalPos + offset;
    newContent =
      newContent.slice(0, adjustedPos) +
      newStr +
      newContent.slice(adjustedPos + oldStr.length);

    editResults.push(extractEditContext(newContent, adjustedPos, newStr));
    offset += newStr.length - oldStr.length;
  }

  return {
    newContent,
    replacementCount: matchPositions.length,
    editResults,
  };
}

function performSingleReplace(
  content: string,
  oldStr: string,
  newStr: string
): ReplaceResult {
  const matchCount = content.split(oldStr).length - 1;
  if (matchCount > 1) {
    throw new Error(
      `old_str found ${matchCount} times in file. ` +
        "Use replace_all: true to replace all occurrences, " +
        "or provide more context to match exactly once."
    );
  }

  const editStartIndex = content.indexOf(oldStr);
  const newContent = content.replace(oldStr, newStr);
  const editResults = [extractEditContext(newContent, editStartIndex, newStr)];

  return {
    newContent,
    replacementCount: 1,
    editResults,
  };
}

export async function executeEditFile({
  path,
  old_str,
  new_str,
  replace_all = false,
}: EditFileInput): Promise<string> {
  if (!path) {
    throw new Error("Missing required parameter: path");
  }
  if (old_str === new_str) {
    throw new Error(
      "old_str and new_str are identical - no changes to make. " +
        "If you intended to make a change, verify the content differs."
    );
  }

  let content: string;

  try {
    content = await readFile(path, "utf-8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      old_str === ""
    ) {
      return await handleFileCreation(path, new_str);
    }
    throw error;
  }

  if (old_str !== "" && !content.includes(old_str)) {
    throw new Error(buildEnhancedErrorMessage(old_str, content));
  }

  const { newContent, replacementCount, editResults } = replace_all
    ? performReplaceAll(content, old_str, new_str)
    : performSingleReplace(content, old_str, new_str);

  if (content === newContent && old_str !== "") {
    throw new Error(buildEnhancedErrorMessage(old_str, content));
  }

  await writeFile(path, newContent, "utf-8");

  const summary = replace_all
    ? `OK - replaced ${replacementCount} occurrence(s)`
    : "OK";

  return `${summary}\n\n${formatEditResult(path, editResults)}`;
}

export const editFileTool = tool({
  description:
    "Replace text in file (surgical edits). " +
    "old_str must match exactly (including whitespace/indentation) - always copy-paste lines from read_file output. " +
    "replace_all: false (default) replaces FIRST match only; use replace_all: true for renaming across file. " +
    "For new files, prefer write_file instead.",
  inputSchema,
  execute: executeEditFile,
});
