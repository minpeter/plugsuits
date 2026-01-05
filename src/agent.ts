import {
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
} from "ai";
import { SYSTEM_PROMPT } from "./prompts/system";
import { tools } from "./tools/index";
import {
  printChunk,
  printAIPrefix,
  printNewline,
  printReasoningChunk,
  printReasoningEnd,
  printReasoningPrefix,
  printTool,
} from "./utils/colors";
import { withRetry } from "./utils/retry";

interface StreamState {
  hasStartedText: boolean;
  hasStartedReasoning: boolean;
}

function endReasoningIfNeeded(state: StreamState): void {
  if (state.hasStartedReasoning) {
    printReasoningEnd();
    state.hasStartedReasoning = false;
  }
}

function endTextIfNeeded(state: StreamState): void {
  if (state.hasStartedText) {
    printNewline();
    state.hasStartedText = false;
  }
}

const DEFAULT_MAX_STEPS = 10;

export class Agent {
  private readonly model: LanguageModel;
  private conversation: ModelMessage[] = [];
  private readonly maxSteps: number;

  constructor(model: LanguageModel, maxSteps = DEFAULT_MAX_STEPS) {
    this.model = model;
    this.maxSteps = maxSteps;
  }

  getConversation(): ModelMessage[] {
    return [...this.conversation];
  }

  loadConversation(messages: ModelMessage[]): void {
    this.conversation = [...messages];
  }

  clearConversation(): void {
    this.conversation = [];
  }

  async chat(userInput: string): Promise<void> {
    this.conversation.push({
      role: "user",
      content: userInput,
    });

    await withRetry(async () => {
      await this.executeStreamingChat();
    });
  }

  private async executeStreamingChat(): Promise<void> {
    const result = streamText({
      model: this.model,
      system: SYSTEM_PROMPT,
      messages: this.conversation,
      tools,
      stopWhen: stepCountIs(this.maxSteps),
    });

    const state: StreamState = {
      hasStartedText: false,
      hasStartedReasoning: false,
    };

    for await (const chunk of result.fullStream) {
      if (chunk.type === "reasoning-delta") {
        if (!state.hasStartedReasoning) {
          printReasoningPrefix();
          state.hasStartedReasoning = true;
        }
        printReasoningChunk(chunk.text);
      } else if (chunk.type === "text-delta") {
        endReasoningIfNeeded(state);
        if (!state.hasStartedText) {
          printAIPrefix();
          state.hasStartedText = true;
        }
        printChunk(chunk.text);
      } else if (chunk.type === "tool-call") {
        endReasoningIfNeeded(state);
        endTextIfNeeded(state);
        printTool(chunk.toolName, chunk.input);
      }
    }

    endReasoningIfNeeded(state);
    endTextIfNeeded(state);

    const response = await result.response;
    this.conversation.push(...response.messages);
  }
}
