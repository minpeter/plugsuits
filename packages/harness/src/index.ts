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
export type { MiddlewareConfig } from "./middleware.js";
export { buildMiddlewareChain } from "./middleware.js";
export type { AgentPaths, AgentPathsOptions } from "./paths.js";
export { createAgentPaths } from "./paths.js";
export { SessionManager } from "./session.js";
export {
  PROMPTS_COMMAND_PREFIX,
  parsePromptsCommandName,
  toPromptsCommandName,
} from "./skill-command-prefix.js";
export type { SkillInfo, SkillsConfig } from "./skills.js";
export { SkillsEngine } from "./skills.js";
export type { TodoConfig, TodoItem } from "./todo-continuation.js";
export { TodoContinuation } from "./todo-continuation.js";
export {
  normalizeFinishReason,
  shouldContinueManualToolLoop,
} from "./tool-loop-control";
export type { PruneResult, PruningConfig } from "./tool-pruning";
export { pruneToolOutputs } from "./tool-pruning";
export type * from "./types";
