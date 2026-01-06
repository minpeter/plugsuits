import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import { colorize } from "./colors";

const COMPACTION_SYSTEM_PROMPT = `You compress a long coding-agent conversation into a single context block that will replace old messages.
Preserve ONLY information needed to continue the task correctly.

Hard rules:
- Keep exact identifiers: file paths, function/class names, CLI commands, flags, config keys, URLs, branch names.
- Keep exact error messages or their essential lines (do NOT paraphrase them away).
- Keep decisions that constrain future actions.
- If information is uncertain, put it in OpenQuestions instead of stating as fact.
- Do not include chit-chat or redundant deliberation.
- Output must follow the exact format below.

OUTPUT FORMAT (exact):
[COMPRESSED_CONTEXT]
Goal:
Constraints:
Repo/Env:
Current state:
Key decisions:
Work completed:
Files touched:
- <path>: <what changed/why>
Current errors / failing tests:
- <command>: <result + key error lines>
OpenQuestions:
NextSteps:
[/COMPRESSED_CONTEXT]`;

export interface CompactionResult {
  messages: ModelMessage[];
  originalMessageCount: number;
  compactedMessageCount: number;
  summary: string;
}

export interface CompactionConfig {
  keepRecentMessages: number;
  maxSummaryTokens: number;
}

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  keepRecentMessages: 8,
  maxSummaryTokens: 1600,
};

interface ContentPart {
  type: string;
  text?: string;
  toolName?: string;
  output?: unknown;
  input?: Record<string, unknown>;
}

const SUMMARY_TAG = "[COMPRESSED_CONTEXT]";
const SUMMARY_TAG_END = "[/COMPRESSED_CONTEXT]";
const MAX_TOOL_PREVIEW_CHARS = 1600;
const TOOL_PREVIEW_HEAD_LINES = 8;
const TOOL_PREVIEW_TAIL_LINES = 4;

function isCompressedSummaryMessage(message: ModelMessage): boolean {
  return (
    typeof message.content === "string" &&
    message.content.includes(SUMMARY_TAG) &&
    message.content.includes(SUMMARY_TAG_END)
  );
}

function getToolResultPreview(output: unknown): string {
  const text =
    typeof output === "string" ? output : JSON.stringify(output, null, 2);

  if (text.length <= MAX_TOOL_PREVIEW_CHARS) {
    return text;
  }

  const lines = text.split("\n");
  if (lines.length <= TOOL_PREVIEW_HEAD_LINES + TOOL_PREVIEW_TAIL_LINES) {
    return text.slice(0, MAX_TOOL_PREVIEW_CHARS);
  }

  const head = lines.slice(0, TOOL_PREVIEW_HEAD_LINES).join("\n");
  const tail = lines
    .slice(-TOOL_PREVIEW_TAIL_LINES)
    .join("\n");
  return `${head}\n...\n${tail}`;
}

function formatContentPart(part: ContentPart): string {
  if (part.type === "text" && part.text) {
    return part.text;
  }
  if (part.type === "tool-call" && part.toolName) {
    const input = part.input ? JSON.stringify(part.input) : "";
    const trimmedInput =
      input.length > 400 ? `${input.slice(0, 400)}…` : input;
    return trimmedInput
      ? `[Tool Call: ${part.toolName} ${trimmedInput}]`
      : `[Tool Call: ${part.toolName}]`;
  }
  if (part.type === "tool-result") {
    const preview = getToolResultPreview(part.output);
    return `[Tool Result]\n${preview}`;
  }
  return "";
}

function formatArrayContent(content: ContentPart[]): string {
  return content.map(formatContentPart).filter(Boolean).join("\n");
}

function formatMessage(msg: ModelMessage): string | null {
  const role = msg.role.toUpperCase();

  if (typeof msg.content === "string") {
    return `[${role}]: ${msg.content}`;
  }

  if (Array.isArray(msg.content)) {
    const content = formatArrayContent(msg.content as ContentPart[]);
    if (content) {
      return `[${role}]: ${content}`;
    }
  }

  return null;
}

function formatMessagesForSummary(messages: ModelMessage[]): string {
  return messages.map(formatMessage).filter(Boolean).join("\n\n");
}

function hasValidSummaryFormat(text: string): boolean {
  const requiredSections = [
    SUMMARY_TAG,
    "Goal:",
    "Constraints:",
    "Repo/Env:",
    "Current state:",
    "Key decisions:",
    "Work completed:",
    "Files touched:",
    "Current errors / failing tests:",
    "OpenQuestions:",
    "NextSteps:",
    SUMMARY_TAG_END,
  ];
  return requiredSections.every((section) => text.includes(section));
}

async function generateSummary(
  model: LanguageModel,
  previousSummary: string | null,
  conversationText: string,
  maxSummaryTokens: number
): Promise<string> {
  const previousText = previousSummary ?? "NONE";
  const prompt = `Previous compressed context (if any):\n${previousText}\n\nNew conversation to incorporate:\n${conversationText}`;
  const result = await generateText({
    model,
    system: COMPACTION_SYSTEM_PROMPT,
    prompt,
    maxOutputTokens: maxSummaryTokens,
  });
  return result.text.trim();
}

function buildSummaryMessage(summary: string): ModelMessage {
  return {
    role: "user",
    content: summary,
  };
}

export async function compactConversation(
  model: LanguageModel,
  messages: ModelMessage[],
  config: Partial<CompactionConfig> = {}
): Promise<CompactionResult> {
  const { keepRecentMessages, maxSummaryTokens } = {
    ...DEFAULT_COMPACTION_CONFIG,
    ...config,
  };

  const summaryMessages = messages.filter(isCompressedSummaryMessage);
  const previousSummary = summaryMessages.at(0)?.content;
  const filteredMessages = messages.filter(
    (message) => !isCompressedSummaryMessage(message)
  );

  if (filteredMessages.length <= keepRecentMessages) {
    const preserved = previousSummary
      ? [buildSummaryMessage(String(previousSummary)), ...filteredMessages]
      : [...filteredMessages];

    return {
      messages: preserved,
      originalMessageCount: messages.length,
      compactedMessageCount: preserved.length,
      summary: previousSummary ? String(previousSummary) : "",
    };
  }

  const messagesToSummarize = filteredMessages.slice(0, -keepRecentMessages);
  const recentMessages = filteredMessages.slice(-keepRecentMessages);

  console.log(
    colorize(
      "yellow",
      `\n[Compacting context: summarizing ${messagesToSummarize.length} messages...]`
    )
  );

  const conversationText = formatMessagesForSummary(messagesToSummarize);

  try {
    let summary = await generateSummary(
      model,
      typeof previousSummary === "string" ? previousSummary : null,
      conversationText,
      maxSummaryTokens
    );

    if (!hasValidSummaryFormat(summary)) {
      const previousText =
        typeof previousSummary === "string" ? previousSummary : "NONE";
      const retryPrompt = `Previous compressed context (if any):\n${previousText}\n\nNew conversation to incorporate:\n${conversationText}\n\nYour output did not match the required format. Please retry with the exact format only.`;
      const retryResult = await generateText({
        model,
        system: COMPACTION_SYSTEM_PROMPT,
        prompt: retryPrompt,
        maxOutputTokens: maxSummaryTokens,
      });
      summary = retryResult.text.trim();
    }

    if (!hasValidSummaryFormat(summary)) {
      throw new Error("Compaction summary format invalid after retry");
    }

    const summaryMessage = buildSummaryMessage(summary);
    const compactedMessages: ModelMessage[] = [summaryMessage, ...recentMessages];

    console.log(
      colorize(
        "green",
        `[Context compacted: ${messages.length} → ${compactedMessages.length} messages]`
      )
    );

    return {
      messages: compactedMessages,
      originalMessageCount: messages.length,
      compactedMessageCount: compactedMessages.length,
      summary,
    };
  } catch (error) {
    console.log(
      colorize(
        "red",
        `[Compaction failed: ${error instanceof Error ? error.message : error}]`
      )
    );

    const fallbackMessages = previousSummary
      ? [buildSummaryMessage(String(previousSummary)), ...recentMessages]
      : recentMessages;

    return {
      messages: fallbackMessages,
      originalMessageCount: messages.length,
      compactedMessageCount: fallbackMessages.length,
      summary: "",
    };
  }
}
