import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    FRIENDLI_TOKEN: z.string().min(1),
    DEBUG_CHUNK_LOG: z.stringbool().default(false),
    DEBUG_CONTEXT_LOG: z.stringbool().default(false),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
