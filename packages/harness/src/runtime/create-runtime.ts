import { createAgent } from "../agent";
import { CheckpointHistory } from "../checkpoint-history";
import { createModelSummarizer } from "../compaction-prompts";
import { SessionManager } from "../session";
import type { SkillInfo } from "../skills";
import type { Agent } from "../types";
import { createAgentSession } from "./agent-session";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  AgentSession,
  AgentSkillsConfig,
  DefineAgentContext,
  DefinedAgent,
} from "./types";

const SKILLS_MODULE = "../skills.js";

const getDefaultCwd = (): string => {
  if (typeof process === "undefined") {
    return "/";
  }

  try {
    return process.cwd();
  } catch {
    return "/";
  }
};

const loadConfiguredSkills = async (
  config: AgentSkillsConfig
): Promise<SkillInfo[]> => {
  const { SkillsEngine }: typeof import("../skills") = await import(
    SKILLS_MODULE
  );
  return await new SkillsEngine(config).loadAllSkills();
};

function assertAgentDefinition<TContext>(
  definition: DefinedAgent<TContext> | undefined,
  name: string
): DefinedAgent<TContext> {
  if (!definition) {
    throw new Error(
      `createAgentRuntime: no agent registered with name "${name}"`
    );
  }

  return definition;
}

function assertRuntimeAgent(agent: Agent | undefined, name: string): Agent {
  if (!agent) {
    throw new Error(
      `createAgentRuntime: shared runtime agent missing for "${name}"`
    );
  }

  return agent;
}

export async function createAgentRuntime<
  TAgents extends readonly DefinedAgent<unknown>[],
  TContext = unknown,
>(
  config: AgentRuntimeConfig<TAgents, TContext>
): Promise<AgentRuntime<TAgents, TContext>> {
  const agentMap = new Map<string, DefinedAgent<TContext>>();
  for (const definition of config.agents as readonly DefinedAgent<TContext>[]) {
    if (agentMap.has(definition.name)) {
      throw new Error(
        `createAgentRuntime: duplicate agent name "${definition.name}"`
      );
    }

    agentMap.set(definition.name, definition);
  }

  const appName = config.name;
  const cwd = config.cwd ?? getDefaultCwd();
  const sharedContext = config.context as TContext;
  const agentInstances = new Map<string, Agent>();

  for (const definition of config.agents as readonly DefinedAgent<TContext>[]) {
    const defineAgentContext: DefineAgentContext<TContext> = {
      appName,
      cwd,
      sessionId: "runtime-init",
      context: sharedContext,
    };
    const agentConfig =
      typeof definition.agent === "function"
        ? await definition.agent(defineAgentContext)
        : definition.agent;

    agentInstances.set(definition.name, await createAgent(agentConfig));
  }

  const sessionManager =
    config.session?.manager ??
    new SessionManager(config.session?.prefix ?? config.name);
  const snapshotStore = config.persistence?.snapshotStore;
  const autoSave = config.persistence?.autoSave ?? snapshotStore !== undefined;
  const defaultAgentName = config.defaultAgent ?? config.agents[0]?.name;

  async function buildSession<TName extends TAgents[number]["name"]>(
    agentName: TName,
    sessionId: string,
    contextOverride?: TContext
  ): Promise<AgentSession<TName, TContext>> {
    const definition = assertAgentDefinition(
      agentMap.get(agentName),
      agentName
    ) as Extract<TAgents[number], { name: TName }>;
    const runtimeAgent = assertRuntimeAgent(
      agentInstances.get(agentName),
      agentName
    );
    const historyOptions = definition.history;
    const compaction = historyOptions?.compaction;
    const needsSummarizer = compaction?.enabled && !compaction.summarizeFn;
    const resolvedHistoryOptions =
      needsSummarizer && compaction
        ? {
            ...historyOptions,
            compaction: {
              ...compaction,
              summarizeFn: createModelSummarizer(runtimeAgent.config.model),
            },
          }
        : historyOptions;
    const history = snapshotStore
      ? await CheckpointHistory.fromSnapshot(
          snapshotStore,
          sessionId,
          resolvedHistoryOptions
        )
      : new CheckpointHistory(resolvedHistoryOptions);
    const skills = definition.skills
      ? await loadConfiguredSkills(definition.skills)
      : [];

    return createAgentSession({
      agentName,
      sessionId,
      context: (contextOverride ?? config.context) as TContext,
      history,
      runtimeAgent,
      commands: definition.commands ?? [],
      skills,
      definition,
      snapshotStore,
      autoSave,
      sessionManager,
      historyDefaults: definition.history,
      appName,
      cwd,
      buildAgent: createAgent,
    });
  }

  function getResolvedAgentName<TName extends TAgents[number]["name"]>(
    agentName?: TName
  ): TName {
    const resolved = agentName ?? defaultAgentName;
    if (!resolved) {
      throw new Error("createAgentRuntime: no agents registered");
    }

    return resolved as TName;
  }

  return {
    name: config.name,

    getAgentNames() {
      return [...agentMap.keys()] as TAgents[number]["name"][];
    },

    getAgent<TName extends TAgents[number]["name"]>(name: TName) {
      return assertAgentDefinition(agentMap.get(name), name) as Extract<
        TAgents[number],
        { name: TName }
      >;
    },

    openSession<TName extends TAgents[number]["name"]>(options?: {
      agent?: TName;
      sessionId?: string;
      context?: TContext;
    }) {
      const agentName = getResolvedAgentName(options?.agent);
      const sessionId = options?.sessionId ?? sessionManager.initialize();

      return buildSession(agentName, sessionId, options?.context);
    },

    resumeSession<TName extends TAgents[number]["name"]>(options: {
      sessionId: string;
      agent?: TName;
      context?: TContext;
    }) {
      const agentName = getResolvedAgentName(options.agent);

      return buildSession(agentName, options.sessionId, options.context);
    },

    async close() {
      await Promise.all(
        [...agentInstances.values()].map(async (agent) => await agent.close())
      );
    },
  };
}
