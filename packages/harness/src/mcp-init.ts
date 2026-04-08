import { join, resolve } from "node:path";

import type { ToolSet } from "ai";

import { loadMCPConfig } from "./mcp-config";
import { MCPManager } from "./mcp-manager";
import { mergeMCPTools } from "./mcp-tool-merger";
import type { MCPServerConfig } from "./mcp-types";
import type { MCPOption } from "./types";

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
    loadFileConfig?: boolean;
    onError?: (server: string, error: unknown) => void;
    servers?: Record<string, MCPServerConfig>;
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
    loadFileConfig: options.loadFileConfig,
    onError: options.onError,
    servers: options.servers,
    toolsTimeout: options.toolsTimeout,
  });
  const initPromise = manager.init().catch((error) => {
    cache.delete(cacheKey);
    throw error;
  });
  const entry: CacheEntry = {
    manager,
    refCount: 1,
    initPromise,
  };
  cache.set(cacheKey, entry);
  return entry;
}

async function resolveConfig(mcp: Exclude<MCPOption, MCPManager>): Promise<{
  cacheKey: string;
  options: {
    configPath?: string;
    loadFileConfig?: boolean;
    onError?: (server: string, error: unknown) => void;
    servers?: Record<string, MCPServerConfig>;
    toolsTimeout?: number;
  };
  servers: Record<string, MCPServerConfig>;
} | null> {
  if (mcp === true) {
    const loaded = await loadMCPConfig();
    return {
      cacheKey: `file:${process.cwd()}/.mcp.json`,
      options: {},
      servers: loaded.mcpServers,
    };
  }

  if (Array.isArray(mcp)) {
    const named = arrayToNamedServers(mcp);
    return {
      cacheKey: `inline:${stableStringify(mcp)}`,
      options: { servers: named },
      servers: named,
    };
  }

  const configPath = typeof mcp.config === "string" ? mcp.config : undefined;
  const resolvedConfigPath = mcp.config
    ? resolve(configPath ?? join(process.cwd(), ".mcp.json"))
    : undefined;
  const fileServers = mcp.config
    ? (await loadMCPConfig(configPath ? { configPath } : undefined)).mcpServers
    : {};
  const inlineServers = mcp.servers ?? [];
  const namedInline = arrayToNamedServers(inlineServers, "inline");
  const allServers = { ...fileServers, ...namedInline };
  const timeoutSuffix =
    mcp.toolsTimeout !== undefined ? `+timeout:${mcp.toolsTimeout}` : "";
  return {
    cacheKey: `combined:${resolvedConfigPath ?? ""}+${stableStringify(inlineServers)}${timeoutSuffix}`,
    options: {
      configPath: mcp.config ? configPath : undefined,
      loadFileConfig: mcp.config ? true : undefined,
      onError: mcp.onError,
      servers: Object.keys(namedInline).length > 0 ? namedInline : undefined,
      toolsTimeout: mcp.toolsTimeout,
    },
    servers: allServers,
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
