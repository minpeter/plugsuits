import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AgentPaths {
  configDir: string;
  todoDir: string;
}

export interface AgentPathsOptions {
  configDirName: string;
  todoBaseDir?: string;
  todoDirName: string;
}

export function createAgentPaths(opts: AgentPathsOptions): AgentPaths {
  return {
    configDir: opts.configDirName,
    todoDir: join(opts.todoBaseDir ?? tmpdir(), opts.todoDirName),
  };
}
