import { harnessEnv } from "@ai-sdk-tool/harness";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_BASE_URL: z.string().url().optional(),
    DEBUG_SHOW_FINISH_REASON: z.stringbool().default(false),
    DEBUG_SHOW_TOOL_RESULTS: z.stringbool().default(false),
    DEBUG_SHOW_RAW_TOOL_IO: z.stringbool().default(false),
    BENCHMARK_SEED: z.coerce.number().int().optional(),
    BENCHMARK_TEMPERATURE: z.coerce.number().optional(),
    ATIF_OUTPUT_PATH: z.string().min(1).optional(),
    DISABLE_BME: z.stringbool().default(false),
  },
  extends: [harnessEnv],
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export const validateProviderConfig = (): void => {
  if (!env.ANTHROPIC_API_KEY) {
    console.error(
      "Error: No provider credentials found.\n" +
        "  export ANTHROPIC_API_KEY=your_anthropic_api_key_here"
    );
    process.exit(1);
  }
};
