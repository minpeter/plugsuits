export interface ContextManagementEdit {
  clearToolNames?: string[];
  excludeToolNames?: string[];
  keep?: { type: string; value: number };
  trigger?: { type: string; value: number };
  type: string;
}

export interface ContextManagementConfig {
  edits: ContextManagementEdit[];
}

export interface ApiContextManagementOptions {
  clearableToolNames?: string[];
  clearThinking?: boolean;
  contextLimit: number;
  excludeToolNames?: string[];
  targetInputTokens?: number;
  triggerInputTokens?: number;
}

const CLEAR_TOOL_RESULTS_EDIT_TYPE = "clear_tool_results";
const CLEAR_THINKING_EDIT_TYPE = "clear_thinking";
const DEFAULT_TARGET_INPUT_RATIO = 0.4;
const DEFAULT_TRIGGER_INPUT_RATIO = 0.8;
const DEFAULT_THINKING_TURNS_TO_KEEP = 1;

const SUPPORT_FLAG_KEYS = [
  "contextManagement",
  "supportsContextManagement",
  "supports_context_management",
  "supports-context-management",
] as const;

function normalizeTokenValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasSupportFlag(metadata: Record<string, unknown>): boolean {
  for (const key of SUPPORT_FLAG_KEYS) {
    if (metadata[key] === true) {
      return true;
    }
  }

  const contextManagement = metadata.contextManagement;
  if (
    isRecord(contextManagement) &&
    (contextManagement.enabled === true || contextManagement.supported === true)
  ) {
    return true;
  }

  return false;
}

export function buildContextManagementConfig(
  options: ApiContextManagementOptions
): ContextManagementConfig {
  const normalizedContextLimit = normalizeTokenValue(options.contextLimit);
  const normalizedTargetInputTokens = normalizeTokenValue(
    options.targetInputTokens ??
      Math.floor(normalizedContextLimit * DEFAULT_TARGET_INPUT_RATIO)
  );
  const normalizedTriggerInputTokens = Math.max(
    normalizedTargetInputTokens,
    normalizeTokenValue(
      options.triggerInputTokens ??
        Math.floor(normalizedContextLimit * DEFAULT_TRIGGER_INPUT_RATIO)
    )
  );

  const toolEdit: ContextManagementEdit = {
    type: CLEAR_TOOL_RESULTS_EDIT_TYPE,
    trigger: {
      type: "input_tokens",
      value: normalizedTriggerInputTokens,
    },
    keep: {
      type: "input_tokens",
      value: normalizedTargetInputTokens,
    },
  };

  if (options.clearableToolNames !== undefined) {
    toolEdit.clearToolNames = [...options.clearableToolNames];
  }

  if (options.excludeToolNames !== undefined) {
    toolEdit.excludeToolNames = [...options.excludeToolNames];
  }

  const edits: ContextManagementEdit[] = [toolEdit];

  if (options.clearThinking ?? true) {
    edits.push({
      type: CLEAR_THINKING_EDIT_TYPE,
      trigger: {
        type: "input_tokens",
        value: normalizedTriggerInputTokens,
      },
      keep: {
        type: "thinking_turns",
        value: DEFAULT_THINKING_TURNS_TO_KEEP,
      },
    });
  }

  return { edits };
}

export function isContextManagementSupported(
  providerMetadata?: Record<string, unknown>
): boolean {
  if (!providerMetadata) {
    return false;
  }

  if (hasSupportFlag(providerMetadata)) {
    return true;
  }

  const capabilities = providerMetadata.capabilities;
  if (isRecord(capabilities) && hasSupportFlag(capabilities)) {
    return true;
  }

  for (const value of Object.values(providerMetadata)) {
    if (isRecord(value) && hasSupportFlag(value)) {
      return true;
    }
  }

  return false;
}
