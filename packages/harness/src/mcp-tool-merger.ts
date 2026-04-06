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
  const conflicts: Array<{ toolName: string; sources: string[] }> = [];
  const processedConflicts = new Set<string>();

  const allMCPEntries: Array<{
    serverName: string;
    toolName: string;
    tool: ToolSet[string];
  }> = [];

  for (const [serverName, serverTools] of Object.entries(mcpTools)) {
    for (const [toolName, tool] of Object.entries(serverTools)) {
      allMCPEntries.push({
        serverName,
        toolName,
        tool: tool as ToolSet[string],
      });
    }
  }

  const toolNameToServers = new Map<string, string[]>();

  for (const entry of allMCPEntries) {
    const existing = toolNameToServers.get(entry.toolName) ?? [];
    toolNameToServers.set(entry.toolName, [...existing, entry.serverName]);
  }

  const mergedTools: ToolSet = { ...localTools };

  for (const entry of allMCPEntries) {
    const { serverName, toolName, tool } = entry;
    const serversWithThisTool = toolNameToServers.get(toolName) ?? [];
    const conflictsWithLocal = localToolNames.has(toolName);
    const conflictsWithOtherMCP = serversWithThisTool.length > 1;

    if (conflictsWithLocal || conflictsWithOtherMCP) {
      const sanitizedServerName = sanitizeServerName(serverName);
      let prefixedName = `${sanitizedServerName}_${toolName}`;
      let suffix = 2;
      while (prefixedName in mergedTools) {
        prefixedName = `${sanitizedServerName}_${toolName}_${suffix}`;
        suffix++;
      }
      mergedTools[prefixedName] = tool;

      const sources = conflictsWithLocal
        ? ["local", ...serversWithThisTool]
        : serversWithThisTool;
      const uniqueSources = [...new Set(sources)];

      if (!processedConflicts.has(toolName)) {
        processedConflicts.add(toolName);
        const conflict = { toolName, sources: uniqueSources };
        conflicts.push(conflict);
        onConflict?.(conflict);
      }
      continue;
    }

    mergedTools[toolName] = tool;
  }

  return { tools: mergedTools, conflicts };
}

export function sanitizeServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}
