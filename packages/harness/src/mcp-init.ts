import type { ToolSet } from "ai";

import { loadMCPConfig } from "./mcp-config.js";
import { MCPManager } from "./mcp-manager.js";
import { mergeMCPTools } from "./mcp-tool-merger.js";
import type { MCPServerConfig } from "./mcp-types.js";
import type { MCPOption } from "./types.js";

interface CacheEntry {
  initPromise: Promise<void>;
  manager: MCPManager;
  refCount: number;
}

const cache = new Map<string, CacheEntry>();

export async function resolveMCPOption(
  mcp: MCPOption,
  localTools: ToolSet
): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  if (mcp instanceof MCPManager) {
    const { tools } = mergeMCPTools({
      localTools,
      mcpTools: mcp.toolsByServer(),
    });

    return {
      tools,
      close: async () => undefined,
    };
  }

  const resolved = await resolveConfig(mcp);
  if (!resolved || Object.keys(resolved.servers).length === 0) {
    return {
      tools: localTools,
      close: async () => undefined,
    };
  }

  const entry = getOrCreateEntry(resolved.cacheKey, resolved.options);
  await entry.initPromise;

  const { tools } = mergeMCPTools({
    localTools,
    mcpTools: entry.manager.toolsByServer(),
  });

  let closed = false;
  return {
    tools,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;

      const current = cache.get(resolved.cacheKey);
      if (!current) {
        return;
      }

      current.refCount -= 1;
      if (current.refCount > 0) {
        return;
      }

      cache.delete(resolved.cacheKey);
      await current.manager.close();
    },
  };
}

export function clearMCPCache(): void {
  cache.clear();
}

function getOrCreateEntry(
  cacheKey: string,
  options: {
    configPath?: string;
    onError?: (server: string, error: unknown) => void;
    toolsTimeout?: number;
  }
): CacheEntry {
  const existing = cache.get(cacheKey);
  if (existing) {
    existing.refCount += 1;
    return existing;
  }

  const manager = new MCPManager({
    configPath: options.configPath,
    onError: options.onError,
    toolsTimeout: options.toolsTimeout,
  });
  const entry: CacheEntry = {
    manager,
    refCount: 1,
    initPromise: manager.init(),
  };
  cache.set(cacheKey, entry);
  return entry;
}

async function resolveConfig(mcp: Exclude<MCPOption, MCPManager>): Promise<{
  cacheKey: string;
  options: {
    configPath?: string;
    onError?: (server: string, error: unknown) => void;
    toolsTimeout?: number;
  };
  servers: Record<string, MCPServerConfig>;
} | null> {
  if (mcp === true) {
    const loaded = await loadMCPConfig();
    return {
      cacheKey: "file:.mcp.json",
      options: {},
      servers: loaded.mcpServers,
    };
  }

  if (Array.isArray(mcp)) {
    return {
      cacheKey: `inline:${stableStringify(sortServers(mcp))}`,
      options: {},
      servers: arrayToNamedServers(mcp),
    };
  }

  const configPath = typeof mcp.config === "string" ? mcp.config : undefined;
  const fileServers = mcp.config
    ? (await loadMCPConfig(configPath ? { configPath } : undefined)).mcpServers
    : {};
  const inlineServers = mcp.servers ?? [];
  return {
    cacheKey: `combined:${configPath ?? (mcp.config ? ".mcp.json" : "")}+${stableStringify(sortServers(inlineServers))}`,
    options: {
      configPath,
      onError: mcp.onError,
      toolsTimeout: mcp.toolsTimeout,
    },
    servers: {
      ...fileServers,
      ...arrayToNamedServers(inlineServers, "inline"),
    },
  };
}

function arrayToNamedServers(
  servers: MCPServerConfig[],
  prefix = "server"
): Record<string, MCPServerConfig> {
  return Object.fromEntries(
    servers.map((server, index) => [`${prefix}-${index + 1}`, server])
  );
}

function sortServers(servers: MCPServerConfig[]): MCPServerConfig[] {
  return [...servers].sort((left, right) =>
    stableStringify(left).localeCompare(stableStringify(right))
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableStringify(entryValue)}`
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
