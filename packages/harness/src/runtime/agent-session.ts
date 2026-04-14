import { randomUUID } from "node:crypto";

import { CheckpointHistory } from "../checkpoint-history";
import { runAgentLoop } from "../loop";
import type { Command } from "../commands";
import type { SkillInfo } from "../skills";
import type { SnapshotStore } from "../snapshot-store";
import type { SessionManager } from "../session";
import type { AgentConfig, Agent, RunnableAgent } from "../types";
import type {
  AgentHistoryConfig,
  AgentSession,
  AgentSessionState,
  DefineAgentContext,
  DefinedAgent,
  ReconfigureOptions,
  RunTurnOptions,
  RunTurnResult,
} from "./types";

export interface CreateAgentSessionParams<TAgentName extends string, TContext> {
  agentName: TAgentName;
  sessionId: string;
  context: TContext;
  history: CheckpointHistory;
  runtimeAgent: RunnableAgent;
  commands: Command[];
  skills: SkillInfo[];
  definition: DefinedAgent<TContext>;
  snapshotStore?: SnapshotStore;
  autoSave: boolean;
  sessionManager?: SessionManager;
  historyDefaults?: AgentHistoryConfig;
  appName: string;
  cwd: string;
  buildAgent: (agentConfig: AgentConfig) => Promise<RunnableAgent>;
}

function isAgent(value: RunnableAgent): value is Agent {
  return "config" in value;
}

function makeDefineAgentContext<TContext>(params: {
  appName: string;
  cwd: string;
  sessionId: string;
  context: TContext;
}): DefineAgentContext<TContext> {
  return {
    appName: params.appName,
    cwd: params.cwd,
    sessionId: params.sessionId,
    context: params.context,
  };
}

class AgentSessionImpl<TAgentName extends string, TContext>
  implements AgentSession<TAgentName, TContext>
{
  readonly agentName: TAgentName;
  readonly context: TContext;
  readonly history: CheckpointHistory;
  readonly commands: Command[];
  readonly skills: SkillInfo[];
  readonly state: AgentSessionState;

  private currentSessionId: string;
  private currentRuntimeAgent: RunnableAgent;
  private readonly definition: DefinedAgent<TContext>;
  private readonly snapshotStore?: SnapshotStore;
  private readonly autoSave: boolean;
  private readonly sessionManager?: SessionManager;
  private readonly historyDefaults?: AgentHistoryConfig;
  private readonly appName: string;
  private readonly cwd: string;
  private readonly buildAgent: (
    agentConfig: AgentConfig
  ) => Promise<RunnableAgent>;

  constructor(params: CreateAgentSessionParams<TAgentName, TContext>) {
    this.agentName = params.agentName;
    this.currentSessionId = params.sessionId;
    this.context = params.context;
    this.history = params.history;
    this.currentRuntimeAgent = params.runtimeAgent;
    this.commands = params.commands;
    this.skills = params.skills;
    this.definition = params.definition;
    this.snapshotStore = params.snapshotStore;
    this.autoSave = params.autoSave;
    this.sessionManager = params.sessionManager;
    this.historyDefaults = params.historyDefaults;
    this.appName = params.appName;
    this.cwd = params.cwd;
    this.buildAgent = params.buildAgent;
    this.state = {
      status: "idle",
      revision: this.history.getRevision(),
    };
  }

  get sessionId(): string {
    return this.currentSessionId;
  }

  get runtimeAgent(): RunnableAgent {
    return this.currentRuntimeAgent;
  }

  getMessagesForLLM() {
    return this.history.getMessagesForLLM();
  }

  addUserMessage(input: string, originalContent?: string): void {
    this.history.addUserMessage(input, originalContent);
    this.syncRevision();
  }

  async runTurn(options?: RunTurnOptions): Promise<RunTurnResult> {
    this.state.status = "running";

    try {
      if (options?.input) {
        this.history.addUserMessage(options.input);
      }
      this.syncRevision();

      const sessionContext = this.getDefineAgentContext();
      const result = await runAgentLoop({
        agent: this.getLoopAgent(),
        messages: this.history.getMessagesForLLM(),
        maxIterations: options?.maxIterations,
        abortSignal: options?.signal,
        onBeforeTurn: async (loopContext) => {
          return await this.definition.onBeforeTurn?.(
            {
              phase:
                loopContext.iteration === 0 ? "new-turn" : "intermediate-step",
              iteration: loopContext.iteration,
              messages: loopContext.messages,
            },
            sessionContext
          );
        },
        onStepComplete: async (step) => {
          this.history.addModelMessages(step.response.messages);
          this.syncRevision();

          if (this.autoSave) {
            await this.save();
          }

          await options?.onStepComplete?.(step);
        },
      });

      const usage = this.definition.measureUsage
        ? await this.definition.measureUsage(result.messages, sessionContext)
        : undefined;

      this.state.lastFinishReason = result.finishReason;

      if (this.autoSave) {
        await this.save();
      }

      await this.definition.onTurnComplete?.(
        {
          finishReason: result.finishReason,
          messages: result.messages,
          usage,
          snapshot: this.history.snapshot(),
        },
        sessionContext
      );

      this.syncRevision();

      return {
        finishReason: result.finishReason,
        iterations: result.iterations,
        messages: result.messages,
        usage,
      };
    } finally {
      this.state.status = "idle";
      this.syncRevision();
    }
  }

  async save(): Promise<void> {
    if (!this.snapshotStore) {
      return;
    }

    await this.snapshotStore.save(
      this.currentSessionId,
      this.history.snapshot()
    );
    this.state.lastSavedAt = Date.now();
    this.syncRevision();
  }

  async reload(): Promise<void> {
    if (!this.snapshotStore) {
      return;
    }

    const snapshot = await this.snapshotStore.load(this.currentSessionId);
    if (snapshot) {
      this.history.restoreFromSnapshot(snapshot);
      this.syncRevision();
    }
  }

  async reset(options?: {
    sessionId?: string;
    clearPersistedSnapshot?: boolean;
  }): Promise<void> {
    const previousSessionId = this.currentSessionId;
    const nextSessionId =
      options?.sessionId ??
      (this.sessionManager ? this.sessionManager.initialize() : randomUUID());

    this.currentSessionId = nextSessionId;
    this.history.resetForSession(nextSessionId);

    if (options?.clearPersistedSnapshot && this.snapshotStore) {
      await this.snapshotStore.delete(previousSessionId);
    }

    this.state.lastFinishReason = undefined;
    this.syncRevision();
  }

  async fork(options?: {
    sessionId?: string;
  }): Promise<AgentSession<TAgentName, TContext>> {
    const newSessionId = options?.sessionId ?? randomUUID();
    const snapshot = this.history.snapshot();
    const newHistory = new CheckpointHistory({
      ...this.historyDefaults,
      sessionId: newSessionId,
    });

    newHistory.restoreFromSnapshot(snapshot);

    if (this.snapshotStore) {
      await this.snapshotStore.save(newSessionId, newHistory.snapshot());
    }

    return createAgentSession({
      agentName: this.agentName,
      sessionId: newSessionId,
      context: this.context,
      history: newHistory,
      runtimeAgent: this.currentRuntimeAgent,
      commands: this.commands,
      skills: this.skills,
      definition: this.definition,
      snapshotStore: this.snapshotStore,
      autoSave: this.autoSave,
      sessionManager: this.sessionManager,
      historyDefaults: this.historyDefaults,
      appName: this.appName,
      cwd: this.cwd,
      buildAgent: this.buildAgent,
    });
  }

  async reconfigure(options: ReconfigureOptions<TContext>): Promise<void> {
    if (options.agent) {
      const defineAgentContext = this.getDefineAgentContext();
      const agentConfig =
        typeof options.agent === "function"
          ? await options.agent(defineAgentContext)
          : options.agent;

      this.currentRuntimeAgent = await this.buildAgent(agentConfig);
    }

    if (options.history?.compaction) {
      this.history.updateCompaction(options.history.compaction);
    }

    if (options.history?.pruning) {
      this.history.updatePruning(options.history.pruning);
    }

    this.syncRevision();
  }

  async close(): Promise<void> {
    await Promise.resolve();
  }

  private getDefineAgentContext(): DefineAgentContext<TContext> {
    return makeDefineAgentContext({
      appName: this.appName,
      cwd: this.cwd,
      sessionId: this.currentSessionId,
      context: this.context,
    });
  }

  private getLoopAgent(): Agent {
    if (!isAgent(this.currentRuntimeAgent)) {
      throw new TypeError(
        "AgentSession runtimeAgent must be a full Agent with config to run turns"
      );
    }

    return this.currentRuntimeAgent;
  }

  private syncRevision(): void {
    this.state.revision = this.history.getRevision();
  }
}

export function createAgentSession<TAgentName extends string, TContext>(
  params: CreateAgentSessionParams<TAgentName, TContext>
): AgentSession<TAgentName, TContext> {
  return new AgentSessionImpl(params);
}
