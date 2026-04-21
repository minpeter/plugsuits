import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const ENV_FILE_CANDIDATES = [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
];

const DOTENV_LINE = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/;
const LINE_BREAK = /\r?\n/;

const unquoteEnvValue = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const quote = trimmed[0];
  if (!((quote === '"' || quote === "'") && trimmed.at(-1) === quote)) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  return quote === '"'
    ? inner
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\r")
        .replaceAll("\\t", "\t")
        .replaceAll('\\"', '"')
        .replaceAll("\\\\", "\\")
    : inner;
};

const parseEnvFile = (content: string): Record<string, string> => {
  const entries: Record<string, string> = {};

  for (const rawLine of content.split(LINE_BREAK)) {
    const line = rawLine.trim();
    if (!(line && !line.startsWith("#"))) {
      continue;
    }

    const match = DOTENV_LINE.exec(line);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (!key) {
      continue;
    }

    entries[key] = unquoteEnvValue(rawValue ?? "");
  }

  return entries;
};

const loadEnvFileCompat = (envPath: string): void => {
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

for (const envPath of new Set(ENV_FILE_CANDIDATES)) {
  if (existsSync(envPath)) {
    loadEnvFileCompat(envPath);
  }
}

export const env = createEnv({
  server: {
    /** Enable compaction debug logging to stderr. */
    COMPACTION_DEBUG: z.stringbool().default(false),

    /**
     * Override the context limit regardless of the model's actual limit.
     * Useful for triggering compaction with fewer messages.
     * Works independently — no longer requires COMPACTION_DEBUG.
     */
    CONTEXT_LIMIT_OVERRIDE: z.coerce.number().int().positive().optional(),

    /** Disable automatic compaction (manual compaction still works). */
    DISABLE_AUTO_COMPACT: z.stringbool().default(false),

    /** Log token usage per summarizer call. */
    DEBUG_TOKENS: z.stringbool().default(false),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
