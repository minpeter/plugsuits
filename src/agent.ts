import { createFriendli } from "@friendliai/ai-provider";
import type { ModelMessage } from "ai";
import { ToolLoopAgent, wrapLanguageModel } from "ai";
import { SYSTEM_PROMPT } from "./context/system-prompt";
import { env } from "./env";
import { trimLeadingNewlinesMiddleware } from "./middleware/trim-leading-newlines";
import { tools } from "./tools";

const DEFAULT_MODEL_ID = "zai-org/GLM-4.6";

const friendli = createFriendli({
  apiKey: env.FRIENDLI_TOKEN,
  includeUsage: true,
});

const createAgent = (modelId: string) =>
  new ToolLoopAgent({
    model: wrapLanguageModel({
      model: friendli(modelId),
      middleware: trimLeadingNewlinesMiddleware,
    }),
    instructions: SYSTEM_PROMPT,
    tools: {
      ...tools,
    },
    maxOutputTokens: 1024,
    providerOptions: {
      friendli: {
        chat_template_kwargs: {
          enable_thinking: true,
        },
      },
    },
  });

class AgentManager {
  private modelId: string = DEFAULT_MODEL_ID;

  getModelId(): string {
    return this.modelId;
  }

  setModelId(modelId: string): void {
    this.modelId = modelId;
  }

  getInstructions(): string {
    return SYSTEM_PROMPT;
  }

  getTools() {
    return tools;
  }

  stream(messages: ModelMessage[]) {
    const agent = createAgent(this.modelId);
    return agent.stream({ messages });
  }
}

export const agentManager = new AgentManager();
