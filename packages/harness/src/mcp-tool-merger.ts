import type { ToolSet } from "ai";
import type { MCPToolMergeResult } from "./mcp-types.js";

export interface ToolConflict {
  sources: string[];
  toolName: string;
}

export interface MergeOptions {
  localTools: ToolSet;
  mcpTools: Record<string, ToolSet>;
  onConflict?: (conflict: ToolConflict) => void;
}

export function mergeMCPTools(options: MergeOptions): MCPToolMergeResult {
  const { localTools, mcpTools, onConflict } = options;

  const localToolNames = new Set(Object.keys(localTools));
  const allMCPEntries = buildMCPEntries(mcpTools);
  const toolNameToServers = buildServerIndex(allMCPEntries);

  const mergedTools: ToolSet = { ...localTools };
  const reservedKeys = new Set(Object.keys(localTools));
  const conflicts: Array<{ toolName: string; sources: string[] }> = [];
  const processedConflicts = new Set<string>();

  for (const { serverName, toolName, tool } of allMCPEntries) {
    const serversWithThisTool = toolNameToServers.get(toolName) ?? [];
    const hasConflict =
      localToolNames.has(toolName) || serversWithThisTool.length > 1;

    if (hasConflict) {
      const alias = resolveAlias(serverName, toolName, reservedKeys);
      mergedTools[alias] = tool;
      reservedKeys.add(alias);
      recordConflict(
        toolName,
        serverName,
        serversWithThisTool,
        localToolNames,
        processedConflicts,
        conflicts,
        onConflict
      );
    } else {
      const key = reservedKeys.has(toolName)
        ? resolveAlias(serverName, toolName, reservedKeys)
        : toolName;
      mergedTools[key] = tool;
      reservedKeys.add(key);
    }
  }

  return { tools: mergedTools, conflicts };
}

function buildMCPEntries(
  mcpTools: Record<string, ToolSet>
): Array<{ serverName: string; toolName: string; tool: ToolSet[string] }> {
  const entries: Array<{
    serverName: string;
    toolName: string;
    tool: ToolSet[string];
  }> = [];
  for (const [serverName, serverTools] of Object.entries(mcpTools)) {
    for (const [toolName, tool] of Object.entries(serverTools)) {
      entries.push({ serverName, toolName, tool: tool as ToolSet[string] });
    }
  }
  return entries;
}

function buildServerIndex(
  entries: Array<{ serverName: string; toolName: string }>
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const { toolName, serverName } of entries) {
    index.set(toolName, [...(index.get(toolName) ?? []), serverName]);
  }
  return index;
}

function resolveAlias(
  serverName: string,
  toolName: string,
  reservedKeys: Set<string>
): string {
  const prefix = sanitizeServerName(serverName);
  let alias = `${prefix}_${toolName}`;
  let suffix = 2;
  while (reservedKeys.has(alias)) {
    alias = `${prefix}_${toolName}_${suffix++}`;
  }
  return alias;
}

function recordConflict(
  toolName: string,
  _serverName: string,
  serversWithTool: string[],
  localToolNames: Set<string>,
  processedConflicts: Set<string>,
  conflicts: Array<{ toolName: string; sources: string[] }>,
  onConflict?: (conflict: ToolConflict) => void
): void {
  if (processedConflicts.has(toolName)) {
    return;
  }
  processedConflicts.add(toolName);
  const sources = localToolNames.has(toolName)
    ? ["local", ...serversWithTool]
    : serversWithTool;
  const conflict = { toolName, sources: [...new Set(sources)] };
  conflicts.push(conflict);
  onConflict?.(conflict);
}

export function sanitizeServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}
