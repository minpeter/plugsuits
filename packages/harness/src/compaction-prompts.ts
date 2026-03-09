import { generateText, type ModelMessage } from "ai";

type GenerateTextModel = Parameters<typeof generateText>[0]["model"];

/**
 * Default structured summarization prompt.
 * Designed to be general-purpose: works for coding agents, roleplay, Q&A, etc.
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
 * Prompt extension for iterative compaction when a previous summary exists.
 * Instructs the model to update/merge the previous summary with new conversation content.
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
 * Options for createModelSummarizer.
 */
export interface ModelSummarizerOptions {
  /**
   * Custom system prompt for the summarization model.
   * If not provided, DEFAULT_SUMMARIZATION_PROMPT is used.
   */
  prompt?: string;

  /**
   * Custom system prompt for iterative compaction (when updating an existing summary).
   * If not provided, ITERATIVE_SUMMARIZATION_PROMPT is used.
   */
  iterativePrompt?: string;

  /**
   * Maximum tokens for the summary output.
   * @default 1024
   */
  maxOutputTokens?: number;
}

/**
 * Extract text content from a ModelMessage for building the summarization input.
 */
function formatMessageForSummarization(message: ModelMessage): string {
  const role = message.role;

  if (typeof message.content === "string") {
    return `[${role}]: ${message.content}`;
  }

  if (!Array.isArray(message.content)) {
    return `[${role}]: (empty)`;
  }

  const parts: string[] = [];
  for (const part of message.content) {
    if (typeof part === "object" && part !== null) {
      if (part.type === "text") {
        parts.push((part as { type: "text"; text: string }).text);
      } else if (part.type === "tool-call") {
        const tc = part as {
          type: "tool-call";
          toolName: string;
          input: unknown;
        };
        const inputStr = JSON.stringify(tc.input);
        const truncatedInput =
          inputStr.length > 200 ? `${inputStr.slice(0, 200)}...` : inputStr;
        parts.push(`[tool-call: ${tc.toolName}(${truncatedInput})]`);
      } else if (part.type === "tool-result") {
        const tr = part as {
          type: "tool-result";
          toolName: string;
          output: unknown;
        };
        const outputStr =
          typeof tr.output === "string"
            ? tr.output
            : JSON.stringify(tr.output);
        const truncatedOutput =
          outputStr.length > 300 ? `${outputStr.slice(0, 300)}...` : outputStr;
        parts.push(`[tool-result: ${tr.toolName} → ${truncatedOutput}]`);
      }
    }
  }

  return `[${role}]: ${parts.join(" ")}`;
}

/**
 * Build the user message content for the summarization call.
 * Formats the conversation history into a readable form.
 * When previousSummary is provided, includes it for iterative compaction.
 */
function buildSummarizationInput(messages: ModelMessage[], previousSummary?: string): string {
  const formatted = messages.map(formatMessageForSummarization);

  if (previousSummary) {
    return `<previous-summary>\n${previousSummary}\n</previous-summary>\n\nUpdate the above summary by incorporating the following new conversation:\n\n${formatted.join("\n\n")}`;
  }

  return `Summarize the following conversation:\n\n${formatted.join("\n\n")}`;
}

/**
 * Create a model-based summarizer function that uses AI SDK's generateText
 * to produce structured summaries of conversation history.
 *
 * @example
 * ```ts
 * import { createModelSummarizer } from "@ai-sdk-tool/harness";
 * import { openai } from "@ai-sdk/openai";
 *
 * const history = new MessageHistory({
 *   compaction: {
 *     enabled: true,
 *     maxTokens: 8192,
 *     summarizeFn: createModelSummarizer(openai("gpt-4o-mini")),
 *   },
 * });
 * ```
 *
 * @param model - An AI SDK compatible model (LanguageModelV2)
 * @param options - Optional configuration for the summarizer
 * @returns A summarize function compatible with CompactionConfig.summarizeFn
 */
export function createModelSummarizer(
  model: GenerateTextModel,
  options?: ModelSummarizerOptions
): (messages: ModelMessage[], previousSummary?: string) => Promise<string> {
  const systemPrompt = options?.prompt ?? DEFAULT_SUMMARIZATION_PROMPT;
  const iterativePrompt = options?.iterativePrompt ?? ITERATIVE_SUMMARIZATION_PROMPT;
  const maxOutputTokens = options?.maxOutputTokens ?? 1024;

  return async (messages: ModelMessage[], previousSummary?: string): Promise<string> => {
    if (messages.length === 0) {
      return "## Summary\nNo conversation history to summarize.\n\n## Context\n- (none)\n\n## Current State\n- (none)";
    }

    const userContent = buildSummarizationInput(messages, previousSummary);
    // Use iterative prompt when updating an existing summary
    const activePrompt = previousSummary ? iterativePrompt : systemPrompt;

    const result = await generateText({
      model,
      system: activePrompt,
      messages: [{ role: "user" as const, content: userContent }],
      maxOutputTokens,
    });

    const text = result.text.trim();

    // If the model returned empty, produce a minimal fallback
    if (!text) {
      return "## Summary\nConversation summary generation failed.\n\n## Context\n- (none)\n\n## Current State\n- (none)";
    }

    return text;
  };
}
