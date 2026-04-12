import { createAgent } from "./agent";
import { CheckpointHistory } from "./checkpoint-history";
import type { SessionStore } from "./session-store";
import type {
  AgentGuardrails,
  LanguageModel,
  RunnableAgent,
  ToolSet,
} from "./types";

const DEFAULT_COMPACTION_CONFIG = {
  enabled: true,
  keepRecentTokens: 2000,
  maxTokens: 8000,
  reserveTokens: 2000,
  thresholdRatio: 0.5,
} as const;

export interface MemoryAgentConfig {
  guardrails?: AgentGuardrails;
  instructions?: string;
  model: LanguageModel;
  tools?: ToolSet;
}

export interface SessionAgentConfig extends MemoryAgentConfig {
  sessionId: string;
  store: SessionStore;
}

export interface PlatformAgentConfig extends SessionAgentConfig {
  hubConfig?: {
    hubBaseUrl: string;
    serviceToken: string;
    connectorNames: string[];
    userId?: string;
  };
}

export function createMemoryAgent(config: MemoryAgentConfig): {
  agent: RunnableAgent;
  history: CheckpointHistory;
} {
  const history = new CheckpointHistory({
    compaction: DEFAULT_COMPACTION_CONFIG,
  });

  const agentPromise = createAgent({
    model: config.model,
    tools: config.tools,
    instructions: config.instructions,
    guardrails: config.guardrails,
  });

  const agent: RunnableAgent = {
    stream: async (opts) => {
      const runtimeAgent = await agentPromise;
      return runtimeAgent.stream(opts);
    },
  };

  return { agent, history };
}

export async function createSessionAgent(config: SessionAgentConfig): Promise<{
  agent: RunnableAgent;
  history: CheckpointHistory;
  save: () => Promise<void>;
}> {
  const [agent, history] = await Promise.all([
    createAgent({
      model: config.model,
      tools: config.tools,
      instructions: config.instructions,
      guardrails: config.guardrails,
    }),
    CheckpointHistory.fromSession(config.store, config.sessionId, {
      compaction: DEFAULT_COMPACTION_CONFIG,
    }),
  ]);

  return {
    agent,
    history,
    save: async () => {
      // CheckpointHistory auto-persists on addUserMessage/addModelMessages
      // when created via fromSession. This is kept for API symmetry.
    },
  };
}

export async function createPlatformAgent(
  config: PlatformAgentConfig
): Promise<{
  agent: RunnableAgent;
  history: CheckpointHistory;
  save: () => Promise<void>;
  hubConfig?: PlatformAgentConfig["hubConfig"];
}> {
  const sessionAgent = await createSessionAgent(config);

  return {
    ...sessionAgent,
    hubConfig: config.hubConfig,
  };
}
