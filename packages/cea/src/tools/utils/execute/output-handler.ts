import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ANSI_ESCAPE_PREFIX = `${String.fromCharCode(27)}${String.fromCharCode(155)}`;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `[${ANSI_ESCAPE_PREFIX}][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g"
);
const MULTIPLE_NEWLINE_PATTERN = /\n{3,}/g;

export interface TruncationResult {
  fullOutputPath?: string;
  originalBytes: number;
  originalLines: number;
  text: string;
  truncated: boolean;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

export function sanitizeOutput(text: string): string {
  return stripAnsi(text)
    .replace(/\r/g, "")
    .replace(MULTIPLE_NEWLINE_PATTERN, "\n\n");
}

async function persistFullOutput(text: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tempPath = join(tmpdir(), `cea-output-${randomUUID()}.txt`);
    try {
      await writeFile(tempPath, text, { encoding: "utf-8", flag: "wx" });
      return tempPath;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Failed to persist truncated output.");
}

export async function truncateOutput(
  text: string,
  options: { maxLines?: number; maxBytes?: number } = {}
): Promise<TruncationResult> {
  const maxLines = options.maxLines ?? 2000;
  const maxBytes = options.maxBytes ?? 51_200;

  const originalLines = text.split("\n").length;
  const originalBytes = Buffer.byteLength(text);

  if (originalLines <= maxLines && originalBytes <= maxBytes) {
    return {
      text,
      truncated: false,
      originalLines,
      originalBytes,
    };
  }

  const firstLineLimit = Math.max(1, Math.floor(maxLines * 0.2));
  const lastLineLimit = Math.max(0, maxLines - 1 - firstLineLimit);

  const lines = text.split("\n");
  const firstLines = lines.slice(0, firstLineLimit);
  const lastStart = Math.max(firstLines.length, lines.length - lastLineLimit);
  const lastLines = lines.slice(lastStart);
  const omittedLineCount = Math.max(
    0,
    lines.length - (firstLines.length + lastLines.length)
  );

  const tempPath = await persistFullOutput(text);

  const truncatedText = [
    ...firstLines,
    `[...] ${omittedLineCount} lines omitted. Full output saved to ${tempPath}. Use read_file to view specific sections.`,
    ...lastLines,
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  return {
    text: truncatedText,
    truncated: true,
    fullOutputPath: tempPath,
    originalLines,
    originalBytes,
  };
}
