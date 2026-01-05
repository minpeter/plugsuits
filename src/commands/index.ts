import type { Interface as ReadlineInterface } from "node:readline";
import type { LanguageModel } from "ai";
import type { Agent } from "../agent";
import { colorize } from "../utils/colors";
import {
  deleteConversation,
  listConversations,
  loadConversation,
  saveConversation,
} from "../utils/conversation-store";
import { selectModel } from "../utils/model-selector";

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
  /quit              - Exit the program
`);
}

function handleHelp(_args: string[], ctx: CommandContext): CommandResult {
  printHelp();
  return { conversationId: ctx.currentConversationId };
}

function handleClear(_args: string[], ctx: CommandContext): CommandResult {
  ctx.agent.clearConversation();
  console.log(colorize("green", "Conversation cleared."));
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
