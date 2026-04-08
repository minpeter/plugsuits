import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessEnv } from "@ai-sdk-tool/harness";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const TRAILING_SLASHES = /\/+$/;

export const env = createEnv({
  server: {
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_WEBHOOK_SECRET_TOKEN: z.string().min(1).optional(),
    TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
    TELEGRAM_API_BASE_URL: z
      .url()
      .default("https://api.telegram.org")
      .transform((v) => v.replace(TRAILING_SLASHES, "")),
    REDIS_URL: z.url(),
    AI_API_KEY: z.string().min(1),
    AI_BASE_URL: z.url(),
    AI_MODEL_ID: z.string().min(1).default("gpt-4o"),
    MAX_ITERATIONS: z.coerce.number().int().positive().default(10),
    TRIGGER_WORDS: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((w) => w.trim().toLowerCase())
          .filter(Boolean)
      ),
    SESSION_DIR: z.string().default(join(tmpdir(), "tgbot-sessions")),
    LOG_LEVEL: z
      .enum(["debug", "info", "warn", "error", "silent"])
      .default("info"),
  },
  extends: [harnessEnv],
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
