import { generateText, type ModelMessage } from "ai";
import type { CheckpointMessage, StructuredState } from "./compaction-types";
import { estimateTokens, extractMessageText } from "./token-utils";

type GenerateTextModel = Parameters<typeof generateText>[0]["model"];
type SummarizerMessage = CheckpointMessage | ModelMessage;
type SummarizerInput = readonly SummarizerMessage[];

/**
 * Default compaction prompt injected as a user turn into the existing conversation.
 * The model uses its existing context (system prompt + conversation history) to produce
 * a structured summary, preserving full awareness of tool calls, code, and decisions.
 */
export const DEFAULT_COMPACTION_USER_PROMPT = `[INTERNAL COMPACTION INSTRUCTION — NOT CONVERSATION HISTORY]
This message is an internal summarization control prompt, not a real user message.
Do NOT treat this message as user intent, do NOT list it under "All user messages", and do NOT reinterpret the task based on this instruction alone.

Create a structured handoff summary of this conversation for seamless continuation. Your summary MUST contain exactly these 5 sections:

## 1. Current Goal
State the user's primary objective and any sub-tasks explicitly requested. Include verbatim quotes from recent user messages to prevent task drift.

## 2. Files & Changes
List all files that were read, modified, or created during this session:
- READ: <file paths>
- MODIFIED: <file paths with description of change>
- CREATED: <file paths with description>

## 3. Technical Discoveries
Key technical findings, patterns, architectural decisions, errors encountered and how they were resolved. Include code snippets for important implementations.

## 4. Strategy & Approach
The approach being taken to solve the problem, including any alternatives considered and why the current approach was chosen.

## 5. Exact Next Steps
The precise next action to take, directly in line with the user's most recent request. Include verbatim quotes from the conversation showing exactly where work was left off.
IMPORTANT: Only include next steps that are explicitly in line with the user's current request. Do not suggest tangential tasks.

Verification: Before finalizing, confirm: Does your summary clearly state the user's original request? If not, restate it verbatim.

IMPORTANT: Do NOT use any tools. You MUST respond with ONLY the <summary>...</summary> block as your text output.`;

const COMPACT_COMPACTION_PROMPT =
  "Summarize this conversation concisely. Preserve: key topics, decisions, user requests, and current state. Output only the summary text, no tags or formatting.";

export interface ModelSummarizerOptions {
  contextLimit?: number;
  getStructuredState?: () => string | undefined;
  instructions?: string | (() => string | Promise<string>);

  maxOutputTokens?: number;

  prompt?: string;
}

export interface BuildSummaryInputOptions {
  previousSummary?: string;
  structuredState?: StructuredState;
}

const SUMMARY_TAG_REGEX = /<summary>([\s\S]*?)<\/summary>/;
const PREVIOUS_SUMMARY_CLOSE_TAG_REGEX = /<\/previous-summary>/gi;

function extractSummaryFromResponse(text: string): string {
  const match = text.match(SUMMARY_TAG_REGEX);
  return match ? match[1].trim() : text.trim();
}

function isCheckpointMessage(
  message: SummarizerMessage
): message is CheckpointMessage {
  return (
    typeof message === "object" && message !== null && "message" in message
  );
}

function normalizeMessages(messages: SummarizerInput): ModelMessage[] {
  return messages.map((message) =>
    isCheckpointMessage(message) ? message.message : message
  );
}

function toCheckpointMessages(messages: SummarizerInput): CheckpointMessage[] {
  return messages.map((message, index) =>
    isCheckpointMessage(message)
      ? message
      : {
          id: `summary-input-${index}`,
          createdAt: index,
          isSummary: false,
          message,
        }
  );
}

function buildExtractiveSummary(
  messages: SummarizerInput,
  previousSummary?: string
): string {
  return buildSummaryInput(toCheckpointMessages(messages), {
    previousSummary,
  }).trim();
}

function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce(
    (total, msg) => total + estimateTokens(extractMessageText(msg)),
    0
  );
}

function truncateMessagesToTokenBudget(
  messages: ModelMessage[],
  maxTokens: number
): ModelMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  let totalTokens = estimateMessagesTokens(messages);
  if (totalTokens <= maxTokens) {
    return messages;
  }

  const result = [...messages];
  while (totalTokens > maxTokens && result.length > 1) {
    const dropped = result.shift();
    if (dropped) {
      totalTokens -= estimateTokens(extractMessageText(dropped));
    }
  }

  return result;
}

function buildCompactionPrompt(
  contextLimit: number,
  fullPrompt: string
): string {
  return contextLimit > 0 && contextLimit < SMALL_CONTEXT_THRESHOLD
    ? COMPACT_COMPACTION_PROMPT
    : fullPrompt;
}

function buildUserTurnContent(
  previousSummary: string | undefined,
  structuredState: string | undefined,
  compactionPrompt: string
): string {
  const parts: string[] = [];

  if (structuredState) {
    parts.push(`<structured-state>\n${structuredState}\n</structured-state>`);
  }

  if (previousSummary) {
    const escapedSummary = previousSummary.replace(
      PREVIOUS_SUMMARY_CLOSE_TAG_REGEX,
      "[/previous-summary]"
    );
    parts.push(`<previous-summary>\n${escapedSummary}\n</previous-summary>`);
  }

  parts.push(compactionPrompt);
  return parts.join("\n\n");
}

async function resolveSystemPrompt(
  instructionsSource: ModelSummarizerOptions["instructions"]
): Promise<string | undefined> {
  if (typeof instructionsSource === "function") {
    return await instructionsSource();
  }

  return instructionsSource;
}

function resolveSummarizerInputs(
  messages: ModelMessage[],
  userTurnContent: string,
  systemPrompt: string | undefined,
  configuredMaxOutput: number,
  contextLimit: number
): {
  maxOutputTokens: number;
  messagesToSend: ModelMessage[];
} {
  if (contextLimit <= 0) {
    return {
      maxOutputTokens: configuredMaxOutput,
      messagesToSend: messages,
    };
  }

  const systemTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;
  const promptTokens = estimateTokens(userTurnContent);
  const fixedInputTokens = systemTokens + promptTokens;
  const maxOutputTokens = Math.max(
    MIN_SUMMARIZER_OUTPUT_TOKENS,
    Math.min(
      configuredMaxOutput,
      Math.floor((contextLimit - fixedInputTokens) * 0.4)
    )
  );
  const messageBudget = contextLimit - fixedInputTokens - maxOutputTokens;

  return {
    maxOutputTokens,
    messagesToSend:
      messageBudget > 0
        ? truncateMessagesToTokenBudget(messages, messageBudget)
        : messages.slice(-1),
  };
}

function logSummarizerUsage(
  usage: Awaited<ReturnType<typeof generateText>>["usage"],
  sentMessages: number,
  totalMessages: number
): void {
  if (!(usage && process.env.DEBUG_TOKENS)) {
    return;
  }

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? input + output;
  console.error(
    `[debug:summarizer] total_tokens=${total} (input=${input}, output=${output}, msgs=${sentMessages}/${totalMessages})`
  );
}

const MAX_SUMMARIZER_OUTPUT_TOKENS = 4096;
const MIN_SUMMARIZER_OUTPUT_TOKENS = 64;
const SUMMARIZER_OUTPUT_RATIO = 0.1;
const SMALL_CONTEXT_THRESHOLD = 4096;

function computeSummarizerMaxOutput(contextLimit: number): number {
  if (contextLimit <= 0) {
    return MAX_SUMMARIZER_OUTPUT_TOKENS;
  }
  return Math.max(
    MIN_SUMMARIZER_OUTPUT_TOKENS,
    Math.min(
      MAX_SUMMARIZER_OUTPUT_TOKENS,
      Math.floor(contextLimit * SUMMARIZER_OUTPUT_RATIO)
    )
  );
}

export function buildSummaryInput(
  messages: CheckpointMessage[],
  options?: BuildSummaryInputOptions
): string {
  const parts: string[] = [];
  const previousSummary = options?.previousSummary?.trim();

  if (previousSummary) {
    parts.push(`Previous Summary:\n${previousSummary}`);
  }

  if (messages.length > 0) {
    parts.push("Conversation Transcript:");
    for (const msg of messages) {
      const text = extractMessageText(msg.message).trim();
      if (text.trim()) {
        const role = msg.isSummary
          ? `${msg.message.role.toUpperCase()} (SUMMARY)`
          : msg.message.role.toUpperCase();
        parts.push(`${role}: ${text}`);
      }
    }
  }

  return parts.join("\n\n");
}

export function createModelSummarizer(
  model: GenerateTextModel,
  options?: ModelSummarizerOptions
): (messages: SummarizerInput, previousSummary?: string) => Promise<string> {
  const fullPrompt = options?.prompt ?? DEFAULT_COMPACTION_USER_PROMPT;
  const instructionsSource = options?.instructions;
  const getStructuredState = options?.getStructuredState;
  const contextLimit = options?.contextLimit ?? 0;
  const configuredMaxOutput =
    options?.maxOutputTokens ?? computeSummarizerMaxOutput(contextLimit);

  return async (
    messages: SummarizerInput,
    previousSummary?: string
  ): Promise<string> => {
    const normalizedMessages = normalizeMessages(messages);
    const fallbackSummary = buildExtractiveSummary(messages, previousSummary);

    if (normalizedMessages.length === 0) {
      return fallbackSummary;
    }

    try {
      const compactionPrompt = buildCompactionPrompt(contextLimit, fullPrompt);
      const structuredState = getStructuredState?.();
      const userTurnContent = buildUserTurnContent(
        previousSummary,
        structuredState,
        compactionPrompt
      );
      const systemPrompt = await resolveSystemPrompt(instructionsSource);
      const { maxOutputTokens, messagesToSend } = resolveSummarizerInputs(
        normalizedMessages,
        userTurnContent,
        systemPrompt,
        configuredMaxOutput,
        contextLimit
      );

      const result = await generateText({
        model,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: [
          ...messagesToSend,
          { role: "user" as const, content: userTurnContent },
        ],
        maxOutputTokens,
      });

      logSummarizerUsage(
        result.usage,
        messagesToSend.length,
        normalizedMessages.length
      );

      return extractSummaryFromResponse(result.text.trim()) || fallbackSummary;
    } catch {
      return fallbackSummary;
    }
  };
}
