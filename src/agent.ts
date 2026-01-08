import { createFriendli } from "@friendliai/ai-provider";
import type { ModelMessage } from "ai";
import { ToolLoopAgent, wrapLanguageModel } from "ai";
import { getEnvironmentContext } from "./context/environment-context";
import { SYSTEM_PROMPT } from "./context/system-prompt";
import { env } from "./env";
import { trimLeadingNewlinesMiddleware } from "./middleware/trim-leading-newlines";
import { tools } from "./tools";

export const DEFAULT_MODEL_ID = "Qwen/Qwen3-235B-A22B-Instruct-2507";
const OUTPUT_TOKEN_MAX = 32_000;

const friendli = createFriendli({
  apiKey: env.FRIENDLI_TOKEN,
  includeUsage: true,
});

const disableApprovalForTools = <T extends Record<string, unknown>>(
  toolsObj: T
): T => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(toolsObj)) {
    if (typeof value === "object" && value !== null) {
      result[key] = { ...value, needsApproval: false };
    } else {
      result[key] = value;
    }
  }
  return result as T;
};

interface CreateAgentOptions {
  disableApproval?: boolean;
  instructions?: string;
}

const createAgent = (modelId: string, options: CreateAgentOptions = {}) =>
  new ToolLoopAgent({
    model: wrapLanguageModel({
      model: friendli(modelId),
      middleware: trimLeadingNewlinesMiddleware,
    }),
    instructions: options.instructions || SYSTEM_PROMPT,
    tools: options.disableApproval ? disableApprovalForTools(tools) : tools,
    maxOutputTokens: OUTPUT_TOKEN_MAX,
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
  private headlessMode = false;

  getModelId(): string {
    return this.modelId;
  }

  setModelId(modelId: string): void {
    this.modelId = modelId;
  }

  setHeadlessMode(enabled: boolean): void {
    this.headlessMode = enabled;
  }

  isHeadlessMode(): boolean {
    return this.headlessMode;
  }

  getInstructions(): string {
    return SYSTEM_PROMPT + getEnvironmentContext();
  }

  getTools() {
    return tools;
  }

  stream(messages: ModelMessage[]) {
    const agent = createAgent(this.modelId, {
      disableApproval: this.headlessMode,
      instructions: this.getInstructions(),
    });
    return agent.stream({ messages });
  }
}

export const agentManager = new AgentManager();
