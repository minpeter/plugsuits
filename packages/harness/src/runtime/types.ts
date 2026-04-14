import type { ModelMessage } from "ai";

import type {
  BeforeTurnResult,
  AgentConfig,
  LoopStepInfo,
  RunnableAgent,
} from "../types";
import type {
  CheckpointHistory,
  CheckpointHistoryOptions,
} from "../checkpoint-history";
import type { HistorySnapshot } from "../history-snapshot";
import type { SnapshotStore } from "../snapshot-store";
import type { SessionManager } from "../session";
import type { SkillInfo } from "../skills";
import type { Command } from "../commands";
import type { UsageMeasurement } from "../usage";

// Context passed to defineAgent callbacks and factory functions
export interface DefineAgentContext<TContext = unknown> {
  appName: string;
  cwd: string;
  sessionId: string;
  context: TContext;
}

// History config for defineAgent — CheckpointHistoryOptions minus sessionId
export interface AgentHistoryConfig
  extends Omit<CheckpointHistoryOptions, "sessionId"> {}

// Skills discovery config
export interface AgentSkillsConfig {
  bundledDir?: string;
  globalSkillsDir?: string;
  globalCommandsDir?: string;
  projectSkillsDir?: string;
  projectCommandsDir?: string;
}

// Core agent declaration — what defineAgent() returns
export interface DefinedAgent<TContext = unknown> {
  readonly kind: "defined-agent";
  name: string;
  version?: string;
  description?: string;
  // Static config OR async factory called once at runtime creation
  agent:
    | AgentConfig
    | ((
        ctx: DefineAgentContext<TContext>
      ) => AgentConfig | Promise<AgentConfig>);
  history?: AgentHistoryConfig;
  commands?: Command[];
  skills?: AgentSkillsConfig;
  measureUsage?: (
    messages: ModelMessage[],
    ctx: DefineAgentContext<TContext>
  ) => Promise<UsageMeasurement | null>;
  onBeforeTurn?: (
    params: {
      phase: "new-turn" | "intermediate-step";
      iteration: number;
      messages: ModelMessage[];
    },
    ctx: DefineAgentContext<TContext>
  ) => BeforeTurnResult | undefined | Promise<BeforeTurnResult | undefined>;
  onTurnComplete?: (
    params: {
      finishReason?: string;
      messages: ModelMessage[];
      usage?: UsageMeasurement | null;
      snapshot?: HistorySnapshot;
    },
    ctx: DefineAgentContext<TContext>
  ) => void | Promise<void>;
}

export interface AgentRuntimePersistenceConfig {
  snapshotStore?: SnapshotStore;
  autoSave?: boolean; // default true when snapshotStore exists
}

export interface AgentRuntimeSessionConfig {
  prefix?: string;
  manager?: SessionManager;
}

export interface AgentRuntimeConfig<
  TAgents extends readonly DefinedAgent<unknown>[],
  TContext = unknown,
> {
  name: string;
  agents: TAgents;
  context?: TContext;
  defaultAgent?: TAgents[number]["name"];
  session?: AgentRuntimeSessionConfig;
  persistence?: AgentRuntimePersistenceConfig;
}

export interface AgentSessionState {
  status: "idle" | "running";
  lastFinishReason?: string;
  lastSavedAt?: number;
  revision: number;
}

export interface RunTurnOptions {
  input?: string;
  maxIterations?: number;
  signal?: AbortSignal;
  onStepComplete?: (step: LoopStepInfo) => void | Promise<void>;
}

export interface RunTurnResult {
  finishReason: string;
  iterations: number;
  messages: ModelMessage[];
  usage?: UsageMeasurement | null;
}

export interface ReconfigureOptions<TContext = unknown> {
  agent?:
    | AgentConfig
    | ((
        ctx: DefineAgentContext<TContext>
      ) => AgentConfig | Promise<AgentConfig>);
  history?: AgentHistoryConfig;
}

export interface AgentSession<
  TAgentName extends string = string,
  TContext = unknown,
> {
  readonly agentName: TAgentName;
  readonly sessionId: string;
  readonly context: TContext;
  readonly history: CheckpointHistory;
  readonly runtimeAgent: RunnableAgent;
  readonly commands: Command[];
  readonly skills: SkillInfo[];
  readonly state: AgentSessionState;

  getMessagesForLLM(): ModelMessage[];
  addUserMessage(input: string, originalContent?: string): void;
  runTurn(options?: RunTurnOptions): Promise<RunTurnResult>;
  save(): Promise<void>;
  reload(): Promise<void>;
  reset(options?: {
    sessionId?: string;
    clearPersistedSnapshot?: boolean;
  }): Promise<void>;
  fork(options?: {
    sessionId?: string;
  }): Promise<AgentSession<TAgentName, TContext>>;
  reconfigure(options: ReconfigureOptions<TContext>): Promise<void>;
  close(): Promise<void>;
}

export interface AgentRuntime<
  TAgents extends readonly DefinedAgent<unknown>[],
  TContext = unknown,
> {
  readonly name: string;
  getAgentNames(): TAgents[number]["name"][];
  getAgent<TName extends TAgents[number]["name"]>(
    name: TName
  ): Extract<TAgents[number], { name: TName }>;
  openSession<TName extends TAgents[number]["name"]>(options?: {
    agent?: TName;
    sessionId?: string;
    context?: TContext;
  }): Promise<AgentSession<TName, TContext>>;
  resumeSession<TName extends TAgents[number]["name"]>(options: {
    sessionId: string;
    agent?: TName;
    context?: TContext;
  }): Promise<AgentSession<TName, TContext>>;
  close(): Promise<void>;
}
