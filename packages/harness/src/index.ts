// biome-ignore lint/performance/noBarrelFile: package public entrypoint must aggregate exports.
export { createAgent } from "./agent";
export type {
  Command,
  CommandContext,
  CommandRegistryConfig,
  CommandResult,
  SkillCommandResult,
} from "./commands";
export {
  configureCommandRegistry,
  createHelpCommand,
  executeCommand,
  getCommands,
  isCommand,
  isSkillCommandResult,
  parseCommand,
  registerCommand,
  resolveRegisteredCommandName,
} from "./commands";
export type { ModelSummarizerOptions } from "./compaction-prompts";
export {
  createModelSummarizer,
  DEFAULT_SUMMARIZATION_PROMPT,
  ITERATIVE_SUMMARIZATION_PROMPT,
} from "./compaction-prompts";
export { runAgentLoop } from "./loop";
export type {
  CompactionConfig,
  CompactionSummary,
  Message,
  MessageHistoryOptions,
} from "./message-history";
export { MessageHistory } from "./message-history";
export type { AgentPaths, AgentPathsOptions } from "./paths.js";
export { createAgentPaths } from "./paths.js";
export { SessionManager } from "./session.js";
export {
  normalizeFinishReason,
  shouldContinueManualToolLoop,
} from "./tool-loop-control";
export type { PruneResult, PruningConfig } from "./tool-pruning";
export { pruneToolOutputs } from "./tool-pruning";
export type * from "./types";
