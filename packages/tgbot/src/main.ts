import { setDefaultResultOrder } from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";

setDefaultResultOrder("ipv4first");
setGlobalDispatcher(new Agent({ connect: { autoSelectFamily: false } }));

await import("./env");
const { closeAgent } = await import("./agent");
const { bot, registerCommands } = await import("./bot");

await bot.initialize();
await registerCommands();

console.log("[tgbot] Bot initialized and running.");

async function shutdown(): Promise<void> {
  try {
    await closeAgent();
  } catch (error) {
    console.error("[tgbot] Error closing agent:", error);
  }
  try {
    await bot.shutdown();
  } catch (error) {
    console.error("[tgbot] Error shutting down bot:", error);
  }
  process.exit(0);
}

process.on("SIGINT", async () => {
  console.log("\n[tgbot] Shutting down...");
  await shutdown();
});

process.on("SIGTERM", async () => {
  await shutdown();
});
