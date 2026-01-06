import type { Interface as ReadlineInterface } from "node:readline";
import type { LanguageModel } from "ai";
import type { Agent } from "../agent";
import { SYSTEM_PROMPT } from "../prompts/system";
import { colorize } from "../utils/colors";
import {
  deleteConversation,
  listConversations,
  loadConversation,
  saveConversation,
} from "../utils/conversation-store";
import { selectModel } from "../utils/model-selector";
import {
  convertToRenderAPIMessages,
  fetchRenderedText,
} from "../utils/render-api";

const apiErrorHandler = (message: string): void => {
  console.log(colorize("red", message));
};

export interface CommandContext {
  agent: Agent;
  currentConversationId: string | undefined;
  currentModelId: string;
  readline: ReadlineInterface;
  setModel: (model: LanguageModel, modelId: string) => void;
  exit: () => void;
}

export interface CommandResult {
  conversationId: string | undefined;
}

type CommandHandler = (
  args: string[],
  ctx: CommandContext
) => CommandResult | Promise<CommandResult>;

function printHelp(): void {
  console.log(`
${colorize("cyan", "Available commands:")}
  /help              - Show this help message
  /clear             - Clear current conversation
  /save              - Save current conversation
  /load <id>         - Load a saved conversation
  /list              - List all saved conversations
  /delete <id>       - Delete a saved conversation
  /models            - List and select available AI models
  /render            - Render conversation as raw prompt text
  /context           - Show context usage statistics
  /compact           - Manually trigger context compaction
  /quit              - Exit the program
`);
}

function handleHelp(_args: string[], ctx: CommandContext): CommandResult {
  printHelp();
  return { conversationId: ctx.currentConversationId };
}

async function handleClear(
  _args: string[],
  ctx: CommandContext
): Promise<CommandResult> {
  ctx.agent.clearConversation();
  console.log(colorize("green", "Conversation cleared."));
  await ctx.agent.refreshContextTokens({ onError: apiErrorHandler });
  return { conversationId: undefined };
}

async function handleSave(
  _args: string[],
  ctx: CommandContext
): Promise<CommandResult> {
  const messages = ctx.agent.getConversation();
  if (messages.length === 0) {
    console.log(colorize("yellow", "No conversation to save."));
    return { conversationId: ctx.currentConversationId };
  }
  const id = await saveConversation(messages, ctx.currentConversationId);
  console.log(colorize("green", `Conversation saved: ${id}`));
  return { conversationId: id };
}

async function handleLoad(
  args: string[],
  ctx: CommandContext
): Promise<CommandResult> {
  const loadId = args[0];
  if (!loadId) {
    console.log(colorize("yellow", "Usage: /load <id>"));
    return { conversationId: ctx.currentConversationId };
  }
  const stored = await loadConversation(loadId);
  if (!stored) {
    console.log(colorize("red", `Conversation not found: ${loadId}`));
    return { conversationId: ctx.currentConversationId };
  }
  ctx.agent.loadConversation(stored.messages);
  await ctx.agent.refreshContextTokens({ onError: apiErrorHandler });
  console.log(
    colorize(
      "green",
      `Loaded conversation: ${loadId} (${stored.metadata.messageCount} messages)`
    )
  );
  return { conversationId: loadId };
}

async function handleList(
  _args: string[],
  ctx: CommandContext
): Promise<CommandResult> {
  const conversations = await listConversations();
  if (conversations.length === 0) {
    console.log(colorize("yellow", "No saved conversations."));
    return { conversationId: ctx.currentConversationId };
  }
  console.log(colorize("cyan", "Saved conversations:"));
  for (const conv of conversations) {
    const date = new Date(conv.updatedAt).toLocaleString();
    const current = conv.id === ctx.currentConversationId ? " (current)" : "";
    console.log(
      `  ${conv.id} - ${conv.messageCount} messages - ${date}${current}`
    );
  }
  return { conversationId: ctx.currentConversationId };
}

async function handleDelete(
  args: string[],
  ctx: CommandContext
): Promise<CommandResult> {
  const deleteId = args[0];
  if (!deleteId) {
    console.log(colorize("yellow", "Usage: /delete <id>"));
    return { conversationId: ctx.currentConversationId };
  }
  const deleted = await deleteConversation(deleteId);
  if (deleted) {
    console.log(colorize("green", `Deleted conversation: ${deleteId}`));
    const newId =
      deleteId === ctx.currentConversationId
        ? undefined
        : ctx.currentConversationId;
    return { conversationId: newId };
  }
  console.log(colorize("red", `Failed to delete: ${deleteId}`));
  return { conversationId: ctx.currentConversationId };
}

function handleQuit(_args: string[], ctx: CommandContext): CommandResult {
  ctx.exit();
  return { conversationId: ctx.currentConversationId };
}

async function handleModels(
  _args: string[],
  ctx: CommandContext
): Promise<CommandResult> {
  const selection = await selectModel(ctx.readline, ctx.currentModelId);

  if (selection) {
    ctx.setModel(selection.model, selection.modelId);
    console.log(colorize("green", `Model changed to: ${selection.modelId}`));
    await ctx.agent.refreshContextTokens({ onError: apiErrorHandler });
  }

  return { conversationId: ctx.currentConversationId };
}

async function handleRender(
  _args: string[],
  ctx: CommandContext
): Promise<CommandResult> {
  const messages = ctx.agent.getConversation();
  if (messages.length === 0) {
    console.log(colorize("yellow", "No conversation to render."));
    return { conversationId: ctx.currentConversationId };
  }

  const apiMessages = convertToRenderAPIMessages(messages, SYSTEM_PROMPT);

  try {
    const renderedText = await fetchRenderedText(
      apiMessages,
      ctx.currentModelId,
      false,
      { onError: apiErrorHandler }
    );
    if (renderedText === null) {
      return { conversationId: ctx.currentConversationId };
    }
    console.log(colorize("cyan", "=== Rendered Prompt ==="));
    console.log(renderedText);
    console.log(colorize("cyan", "======================="));
  } catch (error) {
    console.log(colorize("red", `Error: ${error}`));
  }

  return { conversationId: ctx.currentConversationId };
}

type ColorName = "blue" | "yellow" | "green" | "cyan" | "red" | "dim" | "reset";

function getProgressBarColor(percentage: number): ColorName {
  if (percentage >= 0.8) {
    return "red";
  }
  if (percentage >= 0.6) {
    return "yellow";
  }
  if (percentage >= 0.4) {
    return "cyan";
  }
  return "green";
}

function renderProgressBar(
  usagePercentage: number,
  totalTokens: number,
  maxTokens: number
): void {
  const barWidth = 40;
  const clampedPercentage = Math.min(Math.max(usagePercentage, 0), 1);
  const filledWidth = Math.floor(barWidth * clampedPercentage);
  const emptyWidth = barWidth - filledWidth;

  const filledBar = "█".repeat(filledWidth);
  const emptyBar = "░".repeat(emptyWidth);
  const barColor = getProgressBarColor(clampedPercentage);

  console.log(
    `${colorize(barColor, "Progress: ")}${filledBar}${emptyBar} ${(clampedPercentage * 100).toFixed(1)}% (${totalTokens.toLocaleString()} / ${maxTokens.toLocaleString()})`
  );
}

async function handleCompact(
  _args: string[],
  ctx: CommandContext
): Promise<CommandResult> {
  const messages = ctx.agent.getConversation();
  if (messages.length === 0) {
    console.log(colorize("yellow", "No conversation to compact."));
    return { conversationId: ctx.currentConversationId };
  }

  console.log(colorize("cyan", "=== Context Compaction ==="));
  console.log(colorize("dim", "Compacting conversation..."));

  try {
    await ctx.agent.compactContext();
    console.log(colorize("green", "✓ Conversation compacted successfully."));

    const tokenCount = await ctx.agent.refreshContextTokens({
      onError: apiErrorHandler,
    });
    const stats = ctx.agent.getContextStats();
    const displayTokens = tokenCount ?? stats.totalTokens;
    const label = tokenCount === null ? "  New estimated size:" : "  New size:";
    console.log(
      colorize("dim", `${label} ${displayTokens.toLocaleString()} tokens`)
    );
  } catch (error) {
    console.log(colorize("red", `Compaction failed: ${error}`));
  }

  return { conversationId: ctx.currentConversationId };
}

async function handleContext(
  _args: string[],
  ctx: CommandContext
): Promise<CommandResult> {
  const messages = ctx.agent.getConversation();
  const isEmptyConversation = messages.length === 0;

  console.log(colorize("cyan", "=== Context Usage ==="));
  if (isEmptyConversation) {
    console.log(colorize("dim", "Calculating system prompt + tools size..."));
  } else {
    console.log(colorize("dim", "Calculating accurate token count..."));
  }

  try {
    const tokenCount = await ctx.agent.refreshContextTokens({
      onError: apiErrorHandler,
    });
    if (tokenCount === null) {
      return { conversationId: ctx.currentConversationId };
    }

    const stats = ctx.agent.getContextStats();
    const maxContextTokens = stats.maxContextTokens;
    const usagePercentage = tokenCount / maxContextTokens;
    const { compactionThreshold } = ctx.agent.getContextConfig();

    const tokenLabel = isEmptyConversation
      ? `Total tokens:   ${tokenCount.toLocaleString()} (system prompt + tools)`
      : `Total tokens:   ${tokenCount.toLocaleString()}`;
    console.log(`\n${tokenLabel}`);
    console.log(`Max context:    ${maxContextTokens.toLocaleString()}`);
    console.log("");

    renderProgressBar(usagePercentage, tokenCount, maxContextTokens);

    console.log(`\n${colorize("dim", "Usage Details:")}`);
    console.log(`  Usage percentage: ${(usagePercentage * 100).toFixed(1)}%`);
    console.log(
      `  Usage threshold:  ${(compactionThreshold * 100).toFixed(0)}%`
    );

    if (usagePercentage >= compactionThreshold) {
      console.log(
        colorize("yellow", "  ⚠️  Status:         Compaction recommended!")
      );
      console.log(
        colorize(
          "yellow",
          `    (Usage above ${(compactionThreshold * 100).toFixed(0)}% threshold)`
        )
      );
    } else {
      const remaining = (compactionThreshold - usagePercentage) * 100;
      console.log(colorize("green", "  ✓ Status:         Healthy"));
      console.log(
        colorize(
          "dim",
          `    ${remaining.toFixed(0)}% until compaction threshold`
        )
      );
    }
  } catch (error) {
    console.log(colorize("red", `Error: ${error}`));
  }

  return { conversationId: ctx.currentConversationId };
}

const commands: Record<string, CommandHandler> = {
  help: handleHelp,
  clear: handleClear,
  save: handleSave,
  load: handleLoad,
  list: handleList,
  delete: handleDelete,
  quit: handleQuit,
  exit: handleQuit,
  models: handleModels,
  render: handleRender,
  context: handleContext,
  compact: handleCompact,
};

export function handleCommand(
  input: string,
  ctx: CommandContext
): CommandResult | Promise<CommandResult> {
  const [command, ...args] = input.slice(1).split(" ");
  const handler = commands[command];

  if (handler) {
    return handler(args, ctx);
  }

  console.log(
    colorize(
      "yellow",
      `Unknown command: ${command}. Type /help for available commands.`
    )
  );
  return { conversationId: ctx.currentConversationId };
}
