import { harnessEnv } from "@ai-sdk-tool/harness";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_WEBHOOK_SECRET_TOKEN: z.string().min(1).optional(),
    TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
    REDIS_URL: z.url(),
    AI_API_KEY: z.string().min(1),
    AI_BASE_URL: z.url(),
    AI_MODEL_ID: z.string().min(1).default("gpt-4o"),
    MAX_ITERATIONS: z.coerce.number().int().positive().default(10),
  },
  extends: [harnessEnv],
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
