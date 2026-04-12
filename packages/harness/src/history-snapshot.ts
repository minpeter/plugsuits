import type { ModelMessage } from "ai";
import type { CheckpointMessage } from "./compaction-types";

export interface SerializedMessage {
  id: string;
  message: ModelMessage;
  tokenCount?: number;
  createdAt?: number;
  isSummary?: boolean;
  originalContent?: string;
}

export interface HistorySnapshot {
  messages: SerializedMessage[];
  revision: number;
  contextLimit: number;
  systemPromptTokens: number;
  toolSchemasTokens: number;
  compactionState?: {
    summaryMessageId: string | null;
  };
  compactionConfig?: {
    enabled?: boolean;
    contextLimit?: number;
    keepRecentTokens?: number;
    reserveTokens?: number;
    maxTokens?: number;
    thresholdRatio?: number;
    speculativeStartRatio?: number;
  };
  pruningConfig?: {
    enabled?: boolean;
    eagerPruneToolNames?: string[];
    maxToolOutputTokens?: number;
  };
  actualUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export function serializeMessage(
  message: CheckpointMessage
): SerializedMessage {
  return {
    id: message.id,
    message: message.message,
    tokenCount: undefined,
    createdAt: message.createdAt,
    isSummary: message.isSummary,
    originalContent: message.originalContent,
  };
}

export function deserializeMessage(
  message: SerializedMessage
): CheckpointMessage {
  return {
    id: message.id,
    message: message.message,
    createdAt: message.createdAt ?? Date.now(),
    isSummary: message.isSummary ?? false,
    isSummaryMessage: message.isSummary ?? false,
    originalContent: message.originalContent,
  };
}
