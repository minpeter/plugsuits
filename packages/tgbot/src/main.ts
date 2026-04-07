import { setDefaultResultOrder } from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";

setDefaultResultOrder("ipv4first");
setGlobalDispatcher(new Agent({ connect: { autoSelectFamily: false } }));

import "./env";
import { closeAgent } from "./agent";
import { bot } from "./bot";

await bot.initialize();

console.log("[tgbot] Bot initialized and running.");

process.on("SIGINT", async () => {
  console.log("\n[tgbot] Shutting down...");
  await closeAgent();
  await bot.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeAgent();
  await bot.shutdown();
  process.exit(0);
});
