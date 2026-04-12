import type { ModelMessage } from "ai";
import type { CheckpointMessage } from "./compaction-types";

export interface SerializedMessage {
  createdAt?: number;
  id: string;
  isSummary?: boolean;
  message: ModelMessage;
  originalContent?: string;
  tokenCount?: number;
}

export interface HistorySnapshot {
  actualUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
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
  compactionState?: {
    summaryMessageId: string | null;
  };
  contextLimit: number;
  messages: SerializedMessage[];
  pruningConfig?: {
    enabled?: boolean;
    eagerPruneToolNames?: string[];
    maxToolOutputTokens?: number;
  };
  revision: number;
  systemPromptTokens: number;
  toolSchemasTokens: number;
}

export function serializeMessage(
  message: CheckpointMessage
): SerializedMessage {
  return {
    id: message.id,
    message: message.message,
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
    originalContent: message.originalContent,
  };
}
