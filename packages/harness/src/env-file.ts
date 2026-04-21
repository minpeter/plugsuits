import { readFileSync } from "node:fs";

const DOTENV_LINE_START =
  /^(?:export\s+)?(?<key>[\w.-]+)\s*=\s*(?<valueStart>.*)$/;
const LINE_BREAK = /\r?\n/;

const decodeQuotedValue = (value: string, quote: string): string => {
  if (quote !== '"') {
    return value;
  }

  return value.replaceAll("\\n", "\n");
};

const stripInlineComment = (value: string): string => {
  const commentIndex = value.indexOf("#");
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trimEnd();
};

const findClosingQuoteIndex = (value: string, quote: string): number => {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === quote) {
      return index;
    }
  }
  return -1;
};

export const parseEnvFile = (content: string): Record<string, string> => {
  const entries: Record<string, string> = {};
  const lines = content.split(LINE_BREAK);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();
    if (!(line && !line.startsWith("#"))) {
      continue;
    }

    const match = DOTENV_LINE_START.exec(line);
    const key = match?.groups?.key;
    const valueStart = match?.groups?.valueStart ?? "";
    if (!key) {
      continue;
    }

    const trimmedValue = valueStart.trimStart();
    const quote = trimmedValue[0];
    if (quote === '"' || quote === "'") {
      let quotedValue = trimmedValue.slice(1);
      let closingQuoteIndex = findClosingQuoteIndex(quotedValue, quote);

      while (closingQuoteIndex < 0 && index < lines.length - 1) {
        index += 1;
        quotedValue = `${quotedValue}\n${lines[index] ?? ""}`;
        closingQuoteIndex = findClosingQuoteIndex(quotedValue, quote);
      }

      const value =
        closingQuoteIndex >= 0
          ? quotedValue.slice(0, closingQuoteIndex)
          : quotedValue;
      entries[key] = decodeQuotedValue(value, quote);
      continue;
    }

    entries[key] = stripInlineComment(valueStart).trimStart();
  }

  return entries;
};

export const loadEnvFileCompat = (envPath: string): void => {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
    return;
  }

  const entries = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(entries)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
};
