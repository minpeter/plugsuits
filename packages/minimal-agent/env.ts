import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    AI_API_KEY: z.string().min(1).default(""),
    AI_BASE_URL: z.url().default("https://apis.opengateway.ai/v1"),
    AI_MODEL: z.string().min(1).default("openai/gpt-5.4-mini"),
    AI_CONTEXT_LIMIT: z.coerce.number().int().positive().default(128_000),
    SESSION_DIR: z.string().min(1).default(".minimal-agent/sessions"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
