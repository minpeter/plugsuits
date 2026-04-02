import type { ModelMessage } from "ai";
import type { MicroCompactOptions } from "./micro-compact";

// Forward declaration types for messages that reference Message
// (Message is defined in message-history.ts to avoid circular imports)
export interface Message {
  createdAt: Date;
  id: string;
  modelMessage: ModelMessage;
  originalContent?: string;
}

// --- Core Message Types ---

/** A CheckpointMessage extends ModelMessage with tracking metadata */
export interface CheckpointMessage {
  createdAt: number; // Date.now()
  id: string; // nanoid (e.g. nanoid(10))
  isSummary: boolean; // true if this is a compaction summary message
  isSummaryMessage?: boolean;
  message: ModelMessage; // the underlying AI SDK message
  originalContent?: string; // preserved original content before any rewrite
}

// --- Session Metadata ---

export interface SessionMetadata {
  createdAt: number;
  inputTokens: number;
  outputTokens: number;
  sessionId: string;
  summaryMessageId: string | null;
  updatedAt: number;
}

// --- Configuration ---

/**
 * Configuration options for message compaction.
 * 압축(compaction) 설정 옵션.
 */
export interface CompactionConfig {
  /**
   * Maximum number of tokens allowed in the model's context window.
   * 모델의 컨텍스트 창에 허용되는 최대 토큰 수입니다.
   * Setting this to 0 or undefined means unlimited context.
   * 0으로 설정하거나 undefined면 무제한 컨텍스트를 의미합니다.
   * @default 128000 (typical LLM context window)
   * @minimum 0
   */
  contextLimit?: number;

  /**
   * Whether message compaction is enabled.
   * 메시지 압축(compaction) 활성화 여부입니다.
   * @default false
   */
  enabled?: boolean;
  /**
   * Optional callback that returns structured state to inject into the compaction summary.
   * Crush pattern: inject TODOs, file ops, and other runtime state before summarization.
   * The returned string is wrapped in <structured-state>...</structured-state> XML tags
   * and prepended to the compaction user prompt.
   * 압축 요약에 주입할 구조화된 상태를 반환하는 선택적 콜백입니다.
   */
  getStructuredState?: () => string | undefined;

  /**
   * Number of tokens to keep uncompacted at the end of the conversation.
   * 대화 마지막 부분에서 압축하지 않고 유지할 토큰 수입니다.
   * These recent messages will not be included in the summary compaction.
   * 이 최근 메시지들은 요약 압축에 포함되지 않습니다.
   * @default 2000
   * @minimum 0
   */
  keepRecentTokens?: number;

  /**
   * Maximum tokens allowed before compaction is automatically triggered.
   * 압축이 자동으로 트리거되기 전 허용되는 최대 토큰 수입니다.
   * When total tokens exceed this threshold, compaction begins.
   * 총 토큰 수가 이 임계값을 초과하면 압축이 시작됩니다.
   * @default 8000
   * @minimum 0
   */
  maxTokens?: number;

  microCompact?: MicroCompactOptions | boolean;

  /**
   * Tokens reserved for model output generation.
   * 모델 응답 생성을 위해 예약된 토큰 수입니다.
   * These tokens are set aside to ensure the model can generate responses.
   * 모델이 응답을 생성할 수 있도록 이 토큰이 확보됩니다.
   * This value is subtracted from contextLimit when calculating thresholds.
   * @default 2000
   * @minimum 0
   */
  reserveTokens?: number;

  /**
   * Ratio at which to start speculative/safe compaction early.
   * 조기 추측적(speculative) 압축을 시작하는 비율입니다.
   * Compaction starts at this fraction of maxTokens to prevent reaching limits.
   * 제한에 도달하기 전에 이 비율에서 압축이 시작됩니다.
   * @default 0.5
   * @minimum 0.15
   * @maximum 0.95
   */
  speculativeStartRatio?: number;

  /**
   * Custom function to generate a summary from messages.
   * 메시지로부터 요약을 생성하는 커스텀 함수입니다.
   * @param messages - The messages to summarize / 요약할 메시지 배열
   * @param previousSummary - Optional previous summary to build upon / 이전 요약 기반 확장 (선택)
   * @returns A promise resolving to the summary text / 요약 텍스트로 حل역되는 Promise
   */
  summarizeFn?: (
    messages: ModelMessage[],
    previousSummary?: string
  ) => Promise<string>;

  /**
   * Fraction of contextLimit at which compaction triggers.
   * 압축이 트리거되는 contextLimit의 비율입니다.
   * When (contextLimit - reserveTokens) * thresholdRatio is reached, compaction triggers.
   * @default 0.5
   * @minimum 0
   * @maximum 1
   */
  thresholdRatio?: number;
}

/**
 * Configuration options for message pruning.
 * 메시지 구축(pruning) 설정 옵션입니다.
 */
export interface PruningConfig {
  /**
   * Tool names to eagerly prune when detected in messages.
   * 메시지에서 감지되면 즉시 구축할 도구 이름입니다.
   * @default []
   */
  eagerPruneToolNames?: string[];
  /**
   * Whether message pruning is enabled.
   * 메시지 구축 활성화 여부입니다.
   * @default false
   */
  enabled?: boolean;
  /**
   * Minimum tokens to save for pruning to be worthwhile.
   * 구축이 의미 있기 위한 최소 절약 토큰 수입니다.
   * @default 200
   * @minimum 0
   */
  minSavingsTokens?: number;
  /**
   * Tools to never prune, even if they exceed limits.
   * 제한을 초과해도 절대 구축하지 않을 도구입니다.
   * @default []
   */
  protectedToolNames?: string[];
  /**
   * Number of recent tokens to protect from pruning.
   * 구축에서 보호할 최근 토큰 수입니다.
   * @default 2000
   * @minimum 0
   */
  protectRecentTokens?: number;
  /**
   * Text to replace pruned message content.
   * 구축된 메시지 내용을 대체할 텍스트입니다.
   * @default "[output pruned — too large]"
   */
  replacementText?: string;
}

// --- Continuation ---

export type ContinuationVariant = "manual" | "auto-with-replay" | "tool-loop";

// --- Compaction Results ---

export interface CompactionResult {
  continuationVariant?: ContinuationVariant;
  reason?: string; // why compaction failed, if success=false
  success: boolean;
  summaryMessageId?: string;
  tokensAfter: number;
  tokensBefore: number;
}

export interface PreparedCompactionV2 {
  baseMessageIds: string[];
  replayMessage?: CheckpointMessage; // message to replay after compaction
  revision: number;
  splitIndex: number;
  summaryText: string;
  tokenDelta: number;
}

// --- Token Tracking ---

export interface ActualTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  updatedAt: Date;
}

export interface ActualTokenUsageInput {
  /** @deprecated Use outputTokens instead. */
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** @deprecated Use inputTokens instead. */
  promptTokens?: number;
  totalTokens?: number;
  updatedAt?: Date;
}

export interface ContextUsage {
  limit: number;
  percentage: number; // 0-100
  remaining: number;
  source: "actual" | "estimated";
  used: number;
}

// --- Structured State (for summary injection) ---

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface StructuredState {
  metadata?: Record<string, unknown>;
  todos?: TodoItem[];
}

// --- JSONL Persistence Line Types ---

export interface SessionHeaderLine {
  createdAt: number;
  sessionId: string;
  type: "header";
  version: 1;
}

export interface MessageLine {
  createdAt: number;
  id: string;
  isSummary: boolean;
  message: ModelMessage;
  originalContent?: string;
  type: "message";
}

export interface CheckpointLine {
  summaryMessageId: string;
  type: "checkpoint";
  updatedAt: number;
}

export type SessionFileLine = SessionHeaderLine | MessageLine | CheckpointLine;

// --- Compaction Summary and Segments ---

export interface CompactionSummary {
  createdAt: Date;
  /** ID of the first message that was kept after this summary */
  firstKeptMessageId: string;
  id: string;
  summary: string;
  /** Estimated tokens in the summary */
  summaryTokens: number;
  /** Estimated tokens before compaction */
  tokensBefore: number;
}

export interface CompactionSegment {
  createdAt: Date;
  endMessageId: string;
  estimatedTokens: number;
  id: string;
  messageCount: number;
  messageIds: string[];
  messages: Message[];
  startMessageId: string;
  summary: CompactionSummary | null;
}

export interface PreparedCompactionSegment {
  createdAt: Date;
  endMessageId: string;
  estimatedTokens: number;
  id: string;
  messageCount: number;
  messageIds: string[];
  messages: Message[];
  startMessageId: string;
  summary: CompactionSummary | null;
}

export interface PreparedCompaction {
  actualUsage: ActualTokenUsage | null;
  baseMessageIds: string[];
  baseRevision: number;
  baseSegmentIds: string[];
  compactionMaxTokensAtCreation: number;
  contextLimitAtCreation: number;
  didChange: boolean;
  keepRecentTokensAtCreation: number;
  pendingCompaction: boolean;
  phase: "intermediate-step" | "new-turn";
  rejected: boolean;
  segments: PreparedCompactionSegment[];
  tokenDelta: number;
}
