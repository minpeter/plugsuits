import { createRedisState } from "@chat-adapter/state-redis";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat, type Message, type Thread } from "chat";
import { clearHistory, handleMessage, recordMessage } from "./agent";
import { env } from "./env";

// Both the adapter and the Chat instance need a userName for mention detection.
// The adapter reads TELEGRAM_BOT_USERNAME directly from process.env as a fallback,
// but we pass it explicitly here so both sides stay in sync. If unset, the adapter
// resolves the actual username via Telegram's getMe API during initialize().
const botUsername = env.TELEGRAM_BOT_USERNAME;

const telegram = createTelegramAdapter({
  mode: "polling",
  userName: botUsername,
});

export const bot = new Chat({
  userName: botUsername ?? "bot",
  adapters: { telegram },
  state: createRedisState({ url: env.REDIS_URL }),
  onLockConflict: "force",
  logger: env.LOG_LEVEL,
});

// Register Telegram bot commands via the Bot API so they appear in the
// command picker (the "/" menu in chat). We call the API directly because
// @chat-adapter/telegram's telegramFetch is private and the Chat SDK does
// not expose a command registration API.
async function registerCommands(): Promise<void> {
  const baseUrl = env.TELEGRAM_API_BASE_URL;
  try {
    const res = await fetch(
      `${baseUrl}/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commands: [
            { command: "clear", description: "Clear conversation history" },
          ],
        }),
      }
    );
    if (!res.ok) {
      console.error("[tgbot] Failed to register commands:", await res.text());
    }
  } catch (error) {
    console.error("[tgbot] Failed to register commands:", error);
  }
}

export { registerCommands };

const triggerWords = env.TRIGGER_WORDS;
const CLEAR_COMMAND_RE = /^\/clear(?:@(\w+))?$/i;

function isClearCommand(text: string): boolean {
  const match = text.match(CLEAR_COMMAND_RE);
  if (!match) {
    return false;
  }
  const target = match[1];
  if (!target) {
    return true;
  }
  return !!botUsername && target.toLowerCase() === botUsername.toLowerCase();
}

/**
 * Check whether `message` is a reply to one of the bot's own messages.
 *
 * Chat SDK does not expose reply_to_message in its typed Message, so we
 * reach into `message.raw` (the original Telegram API payload). Each
 * nesting level is guarded with runtime typeof checks so the function
 * returns false instead of throwing if the raw shape changes.
 */
function isReplyToBot(message: Message): boolean {
  const raw = message.raw;
  if (typeof raw !== "object" || raw === null) {
    return false;
  }
  const reply = (raw as Record<string, unknown>).reply_to_message;
  if (typeof reply !== "object" || reply === null) {
    return false;
  }
  const from = (reply as Record<string, unknown>).from;
  if (typeof from !== "object" || from === null) {
    return false;
  }
  const { is_bot, username } = from as {
    is_bot?: boolean;
    username?: string;
  };
  if (is_bot !== true) {
    return false;
  }
  if (botUsername && typeof username === "string") {
    return username.toLowerCase() === botUsername.toLowerCase();
  }
  return !botUsername && is_bot;
}

function hasTriggerWord(text: string): boolean {
  if (triggerWords.length === 0) {
    return false;
  }
  const lower = text.toLowerCase();
  return triggerWords.some((w) => lower.includes(w));
}

async function respond(thread: Thread): Promise<void> {
  try {
    await thread.startTyping();
    const text = await handleMessage(thread.id);
    try {
      await thread.post({ markdown: text });
    } catch (markdownError) {
      console.warn(
        "[tgbot] Markdown post failed, falling back to plain text:",
        markdownError
      );
      await thread.post(text);
    }
  } catch (error) {
    console.error("[tgbot] Error handling message:", error);
    try {
      await thread.post("Sorry, something went wrong. Please try again.");
    } catch (sendError) {
      console.error("[tgbot] Failed to send error message:", sendError);
    }
  }
}

async function handleIncoming(thread: Thread, message: Message): Promise<void> {
  const text = message.text;
  if (!text) {
    return;
  }

  if (isClearCommand(text)) {
    clearHistory(thread.id);
    await thread.post(
      "History cleared. Mention me to start a new conversation."
    );
    return;
  }

  const shouldRespond =
    message.isMention || hasTriggerWord(text) || isReplyToBot(message);

  await recordMessage(thread.id, text);

  if (shouldRespond) {
    await thread.subscribe();
    await respond(thread);
  }
}

bot.onNewMention(async (thread, message) => {
  await handleIncoming(thread, message);
});

bot.onSubscribedMessage(async (thread, message) => {
  await handleIncoming(thread, message);
});

// NOTE: onNewMessage with a catch-all pattern (/.*/). This only fires for
// messages in unsubscribed threads that do NOT @-mention the bot. For it to
// receive group messages the bot must either be a group admin or have Privacy
// Mode disabled in BotFather (Bot Settings → Group Privacy → Turn off).
bot.onNewMessage(/.*/, async (thread, message) => {
  await handleIncoming(thread, message);
});
