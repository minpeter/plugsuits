#!/usr/bin/env bun
import { createInterface, emitKeypressEvents } from "node:readline";
import { createFriendli } from "@friendliai/ai-provider";
import type { LanguageModel } from "ai";
import { Agent } from "./agent";
import { handleCommand } from "./commands";
import { env } from "./env";
import { wrapModel } from "./model/create-model";
import { colorize, printYou } from "./utils/colors";

const DEFAULT_MODEL_ID = "zai-org/GLM-4.6";

const friendli = createFriendli({
  apiKey: env.FRIENDLI_TOKEN,
  includeUsage: true,
});

let currentModelId = DEFAULT_MODEL_ID;
const agent = new Agent(wrapModel(friendli(currentModelId)));
let currentConversationId: string | undefined;

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

emitKeypressEvents(process.stdin);

function setupEscHandler(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  process.stdin.on("keypress", (_chunk, key) => {
    if (key?.name === "escape" && agent.isRunning()) {
      agent.abort();
    }
  });
}

function getUserInput(): Promise<string | null> {
  return new Promise((resolve) => {
    printYou();

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    const onLine = (line: string) => {
      rl.removeListener("close", onClose);
      resolve(line);
    };

    const onClose = () => {
      rl.removeListener("line", onLine);
      resolve(null);
    };

    rl.once("line", onLine);
    rl.once("close", onClose);
  });
}

function exitProgram(): void {
  rl.close();
  process.exit(0);
}

function setModel(model: LanguageModel, modelId: string): void {
  agent.setModel(wrapModel(model));
  currentModelId = modelId;
}

async function main(): Promise<void> {
  console.log(`Chat with AI (model: ${currentModelId})`);
  console.log("Use '/help' for commands, 'ESC' to interrupt, 'ctrl-c' to quit");
  console.log();

  setupEscHandler();

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

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    try {
      const { aborted } = await agent.chat(userInput);
      if (aborted) {
        console.log(colorize("dim", "(You can continue typing)"));
      }
    } catch (error) {
      console.error("An error occurred:", error);
    }

    console.log();
  }

  rl.close();
}

main().catch(console.error);
