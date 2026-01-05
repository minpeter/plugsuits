import { createInterface } from "node:readline";
import { createFriendli } from "@friendliai/ai-provider";
import type { LanguageModel } from "ai";
import { Agent } from "./agent";
import { handleCommand } from "./commands";
import { printYou } from "./utils/colors";

const DEFAULT_MODEL_ID = "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8";

const friendli = createFriendli({
  apiKey: process.env.FRIENDLI_TOKEN,
});

let currentModelId = DEFAULT_MODEL_ID;
const agent = new Agent(friendli(currentModelId));
let currentConversationId: string | undefined;

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function getUserInput(): Promise<string | null> {
  return new Promise((resolve) => {
    printYou();
    rl.once("line", (line) => {
      resolve(line);
    });
    rl.once("close", () => {
      resolve(null);
    });
  });
}

function exitProgram(): void {
  rl.close();
  process.exit(0);
}

function setModel(model: LanguageModel, modelId: string): void {
  agent.setModel(model);
  currentModelId = modelId;
}

async function main(): Promise<void> {
  console.log(`Chat with AI (model: ${currentModelId})`);
  console.log("Use '/help' for commands, 'ctrl-c' to quit");
  console.log();

  while (true) {
    const userInput = await getUserInput();

    if (userInput === null) {
      break;
    }

    const trimmed = userInput.trim();
    if (trimmed === "") {
      continue;
    }

    if (trimmed.startsWith("/")) {
      const result = await handleCommand(trimmed, {
        agent,
        currentConversationId,
        currentModelId,
        readline: rl,
        setModel,
        exit: exitProgram,
      });
      currentConversationId = result.conversationId;
      console.log();
      continue;
    }

    try {
      await agent.chat(userInput);
    } catch (error) {
      console.error("An error occurred:", error);
    }

    console.log();
  }

  rl.close();
}

main().catch(console.error);
