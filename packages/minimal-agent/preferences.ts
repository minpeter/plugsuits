import {
  createLayeredPreferences,
  type LayeredPreferences,
} from "@ai-sdk-tool/harness/preferences";
import { z } from "zod";

const SCHEMA_VERSION = 1;
const APP_NAME = "minimal-agent";

const schema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION).optional(),
    reasoningEnabled: z.boolean().optional(),
  })
  .partial()
  .strip();

export interface MinimalAgentPreferences {
  reasoningEnabled?: boolean;
}

const validate = (value: unknown): MinimalAgentPreferences | null => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const { schemaVersion: _ignored, ...rest } = parsed.data;
  const cleaned: MinimalAgentPreferences = {};
  if (rest.reasoningEnabled !== undefined) {
    cleaned.reasoningEnabled = rest.reasoningEnabled;
  }
  return Object.keys(cleaned).length === 0 ? null : cleaned;
};

export const createPreferences =
  (): LayeredPreferences<MinimalAgentPreferences> =>
    createLayeredPreferences<MinimalAgentPreferences>({
      appName: APP_NAME,
      validate,
    });
