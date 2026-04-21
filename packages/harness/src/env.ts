import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { loadEnvFileCompat } from "./env-file";

const findWorkspaceRootEnv = (startDir: string): string | null => {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) {
      return resolve(current, ".env");
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
};

const ENV_FILE_CANDIDATES = [
  resolve(process.cwd(), ".env"),
  findWorkspaceRootEnv(process.cwd()),
].filter((envPath): envPath is string => envPath !== null);

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
