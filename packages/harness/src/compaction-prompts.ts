import { generateText, type ModelMessage } from "ai";
import type { CheckpointMessage, StructuredState } from "./compaction-types";
import { estimateTokens, extractMessageText } from "./token-utils";

type GenerateTextModel = Parameters<typeof generateText>[0]["model"];
type SummarizerMessage = CheckpointMessage | ModelMessage;
type SummarizerInput = readonly SummarizerMessage[];

/**
 * @deprecated Use DEFAULT_COMPACTION_USER_PROMPT instead.
 * Legacy system prompt for standalone summarization calls.
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `You are a conversation summarizer. Given a conversation history, produce a structured summary that preserves the essential context needed to continue the conversation naturally.

Output format (use exactly these headers):

## Summary
[2-4 sentences capturing the key points of the conversation so far]

## Context
- [Important details: names, preferences, technical specs, constraints]
- [Decisions that were made and why]
- [Any specific values, configurations, or parameters mentioned]

## Current State
- [What was being discussed or worked on most recently]
- [Any pending questions or unresolved topics]
- [Next steps that were planned or implied]

Rules:
- Be concise but preserve critical details (exact names, numbers, code snippets if short)
- Do NOT fabricate information not present in the conversation
- If tool calls/results are present, summarize what tools were used and their key outcomes
- Prioritize information that would be needed to continue the conversation
- Use bullet points for clarity
- Keep the total summary under 500 words`;

/**
 * @deprecated Iterative compaction is now handled within the user-turn prompt.
 * Legacy system prompt for iterative summarization.
 */
export const ITERATIVE_SUMMARIZATION_PROMPT = `You are a conversation summarizer performing an iterative update. You have a previous summary of earlier conversation, and new conversation messages to incorporate.

Your task: UPDATE the previous summary by merging in the new conversation content. Do not simply append — integrate the new information into a cohesive, updated summary.

Output format (use exactly these headers):

## Summary
[2-4 sentences capturing the key points of the ENTIRE conversation so far, including both previous context and new messages]

## Context
- [Important details: names, preferences, technical specs, constraints]
- [Decisions that were made and why — include both old and new]
- [Any specific values, configurations, or parameters mentioned]

## Current State
- [What was being discussed or worked on most recently]
- [Any pending questions or unresolved topics]
- [Next steps that were planned or implied]

Rules:
- MERGE previous context with new conversation — don't lose important earlier context
- If new information contradicts or supersedes previous context, use the newer version
- Be concise but preserve critical details (exact names, numbers, code snippets if short)
- Do NOT fabricate information not present in either the previous summary or conversation
- If tool calls/results are present, summarize what tools were used and their key outcomes
- Prioritize information that would be needed to continue the conversation
- Use bullet points for clarity
- Keep the total summary under 500 words`;

/**
 * Default compaction prompt injected as a user turn into the existing conversation.
 * The model uses its existing context (system prompt + conversation history) to produce
 * a structured summary, preserving full awareness of tool calls, code, and decisions.
 */
export const DEFAULT_COMPACTION_USER_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary.

IMPORTANT: Do NOT use any tools. You MUST respond with ONLY the <summary>...</summary> block as your text output.`;

const COMPACT_COMPACTION_PROMPT =
  "Summarize this conversation concisely. Preserve: key topics, decisions, user requests, and current state. Output only the summary text, no tags or formatting.";

export interface ModelSummarizerOptions {
  contextLimit?: number;
  instructions?: string | (() => string | Promise<string>);
  /**
   * @deprecated No longer used. Iterative compaction is handled within the user turn.
   */
  iterativePrompt?: string;

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
  compactionPrompt: string
): string {
  if (!previousSummary) {
    return compactionPrompt;
  }

  const escapedSummary = previousSummary.replace(
    PREVIOUS_SUMMARY_CLOSE_TAG_REGEX,
    "[/previous-summary]"
  );

  return `<previous-summary>\n${escapedSummary}\n</previous-summary>\n\n${compactionPrompt}`;
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

const DEFAULT_SUMMARIZER_MAX_OUTPUT = 4096;
const MIN_SUMMARIZER_OUTPUT_TOKENS = 64;
const SMALL_CONTEXT_THRESHOLD = 4096;

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
  const configuredMaxOutput =
    options?.maxOutputTokens ?? DEFAULT_SUMMARIZER_MAX_OUTPUT;
  const instructionsSource = options?.instructions;
  const contextLimit = options?.contextLimit ?? 0;

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
      const userTurnContent = buildUserTurnContent(
        previousSummary,
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
