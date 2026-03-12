import { createAgentPaths } from "@ai-sdk-tool/harness";

const agentPaths = createAgentPaths({
  configDirName: ".cea",
  todoDirName: "cea-todos",
});

export const CEA_DIR = agentPaths.configDir;
export const TODO_DIR = agentPaths.todoDir;
