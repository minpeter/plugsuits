import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

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
