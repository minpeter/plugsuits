import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    FRIENDLI_TOKEN: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    DEBUG_SHOW_FINISH_REASON: z.stringbool().default(false),
    DEBUG_SHOW_TOOL_RESULTS: z.stringbool().default(false),
    DEBUG_TMUX_CLEANUP: z.stringbool().default(false),
    TMUX_CLEANUP_SESSION: z.stringbool().default(true),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
