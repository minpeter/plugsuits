import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_BASE_URL: z.string().min(1).optional(),
    ANTHROPIC_MODEL: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
