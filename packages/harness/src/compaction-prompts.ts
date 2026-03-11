import { generateText, type ModelMessage } from "ai";

type GenerateTextModel = Parameters<typeof generateText>[0]["model"];

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

export interface ModelSummarizerOptions {
  instructions?: string | (() => string | Promise<string>);
  /**
   * @deprecated No longer used. Iterative compaction is handled within the user turn.
   */
  iterativePrompt?: string;

  maxOutputTokens?: number;

  prompt?: string;
}

const SUMMARY_TAG_REGEX = /<summary>([\s\S]*?)<\/summary>/;
const PREVIOUS_SUMMARY_CLOSE_TAG_REGEX = /<\/previous-summary>/gi;

function extractSummaryFromResponse(text: string): string {
  const match = text.match(SUMMARY_TAG_REGEX);
  return match ? match[1].trim() : text.trim();
}

export function createModelSummarizer(
  model: GenerateTextModel,
  options?: ModelSummarizerOptions
): (messages: ModelMessage[], previousSummary?: string) => Promise<string> {
  const compactionPrompt = options?.prompt ?? DEFAULT_COMPACTION_USER_PROMPT;
  const maxOutputTokens = options?.maxOutputTokens ?? 4096;
  const instructionsSource = options?.instructions;

  return async (
    messages: ModelMessage[],
    previousSummary?: string
  ): Promise<string> => {
    if (messages.length === 0) {
      return "## Summary\nNo conversation history to summarize.\n\n## Context\n- (none)\n\n## Current State\n- (none)";
    }

    let userTurnContent: string;
    if (previousSummary) {
      const escapedSummary = previousSummary.replace(
        PREVIOUS_SUMMARY_CLOSE_TAG_REGEX,
        "[/previous-summary]"
      );
      userTurnContent = `<previous-summary>\n${escapedSummary}\n</previous-summary>\n\n${compactionPrompt}`;
    } else {
      userTurnContent = compactionPrompt;
    }

    const systemPrompt =
      typeof instructionsSource === "function"
        ? await instructionsSource()
        : instructionsSource;

    const result = await generateText({
      model,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [
        ...messages,
        { role: "user" as const, content: userTurnContent },
      ],
      maxOutputTokens,
    });

    const text = result.text.trim();

    if (!text) {
      return "## Summary\nConversation summary generation failed.\n\n## Context\n- (none)\n\n## Current State\n- (none)";
    }

    return extractSummaryFromResponse(text);
  };
}
