import type { Command, CommandResult, CommandContext } from "./types";
import { MessageHistory } from "../context/message-history";

export const createClearCommand = (messageHistory: MessageHistory): Command => ({
  name: "clear",
  description: "Clear current conversation history",
  execute: (context: CommandContext): CommandResult => {
    messageHistory.clear();
    return {
      success: true,
      message: "Conversation history cleared."
    };
  }
});
