import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    FRIENDLI_TOKEN: z.string().min(1).optional(),
    FRIENDLI_BASE_URL: z.string().url().optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_BASE_URL: z.string().url().optional(),
    DEBUG_SHOW_FINISH_REASON: z.stringbool().default(false),
    DEBUG_SHOW_TOOL_RESULTS: z.stringbool().default(false),
    DEBUG_SHOW_RAW_TOOL_IO: z.stringbool().default(false),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export const validateProviderConfig = (): void => {
  if (!(env.FRIENDLI_TOKEN || env.ANTHROPIC_API_KEY)) {
    console.error(
      "Error: No provider credentials found.\n" +
        "Please set either FRIENDLI_TOKEN or ANTHROPIC_API_KEY in your environment.\n" +
        "  export FRIENDLI_TOKEN=your_friendli_token_here\n" +
        "  # or\n" +
        "  export ANTHROPIC_API_KEY=your_anthropic_api_key_here"
    );
    process.exit(1);
  }
};
