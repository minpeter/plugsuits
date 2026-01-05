import { createInterface } from "node:readline";
import { createFriendli } from "@friendliai/ai-provider";
import { Agent } from "./agent";
import { handleCommand } from "./commands";
import { printYou } from "./utils/colors";

const friendli = createFriendli({
  apiKey: process.env.FRIENDLI_TOKEN,
});

const model = friendli("LGAI-EXAONE/K-EXAONE-236B-A23B");

const agent = new Agent(model);
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

async function main(): Promise<void> {
  console.log("Chat with AI (use '/help' for commands, 'ctrl-c' to quit)");
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
