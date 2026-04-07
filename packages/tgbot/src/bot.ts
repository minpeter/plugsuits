import { Chat, type Thread } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createRedisState } from "@chat-adapter/state-redis";
import { clearHistory, handleMessage } from "./agent";
import { env } from "./env";

const telegram = createTelegramAdapter({
  mode: "polling",
});

export const bot = new Chat({
  userName: env.TELEGRAM_BOT_USERNAME ?? "Apex",
  adapters: { telegram },
  state: createRedisState({ url: env.REDIS_URL }),
  onLockConflict: "force",
});

async function respond(thread: Thread, messageText: string): Promise<void> {
  try {
    await thread.startTyping();
    const text = await handleMessage(thread.id, messageText);
    try {
      await thread.post({ markdown: text });
    } catch {
      await thread.post(text);
    }
  } catch (error) {
    console.error("[tgbot] Error handling message:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    await thread.post(`Error: ${errMsg}`);
  }
}

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await respond(thread, message.text);
});

bot.onSubscribedMessage(async (thread, message) => {
  if (message.text?.toLowerCase() === "/clear") {
    clearHistory(thread.id);
    await thread.unsubscribe();
    await thread.post(
      "History cleared. Mention me to start a new conversation."
    );
    return;
  }

  await respond(thread, message.text);
});
