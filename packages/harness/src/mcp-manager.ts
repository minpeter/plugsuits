import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";

import { isStdioConfig, loadMCPConfig } from "./mcp-config.js";
import { mergeMCPTools } from "./mcp-tool-merger.js";
import type {
  MCPManagerOptions,
  MCPServerConfig,
  MCPServerStatus,
} from "./mcp-types.js";

const DEFAULT_TOOLS_TIMEOUT_MS = 30_000;

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

interface ManagedClient {
  client: MCPClient;
  name: string;
}

export class MCPManager {
  private readonly options: MCPManagerOptions;
  private clients: ManagedClient[] = [];
  private mergedTools: ToolSet = {};
  private mcpToolsByServer: Record<string, ToolSet> = {};
  private readonly statuses = new Map<string, MCPServerStatus>();
  private initialized = false;
  private closed = false;
  private initPromise: Promise<void> | null = null;

  constructor(options: MCPManagerOptions = {}) {
    this.options = options;
  }

  init(): Promise<void> {
    if (this.initialized) {
      return Promise.resolve();
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    if (this.closed) {
      return Promise.reject(
        new Error("MCPManager has been closed. Create a new instance.")
      );
    }

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  toolsByServer(): Record<string, ToolSet> {
    if (!this.initialized) {
      throw new Error("MCPManager not initialized. Call init() first.");
    }

    return { ...this.mcpToolsByServer };
  }

  private async doInit(): Promise<void> {
    if (this.closed) {
      throw new Error("MCPManager has been closed. Create a new instance.");
    }

    try {
      const config = await loadMCPConfig({
        configPath: this.options.configPath,
      });
      const serverEntries = Object.entries({
        ...config.mcpServers,
        ...this.options.servers,
      });
      const mcpTools: Record<string, ToolSet> = {};

      const connectionResults = await Promise.allSettled(
        serverEntries.map(async ([name, serverConfig]) => {
          const client = await this.connectServer(name, serverConfig);
          return { name, client };
        })
      );

      for (const [index, result] of connectionResults.entries()) {
        const [serverName] = serverEntries[index] ?? [];

        if (!serverName) {
          continue;
        }

        if (result.status === "rejected") {
          this.recordFailure(serverName, result.reason);
          continue;
        }

        const { client } = result.value;
        this.clients.push({ name: serverName, client });
      }

      if (this.closed) {
        await this.close();
        throw new Error("MCPManager has been closed. Create a new instance.");
      }

      const connectedClients = this.clients;
      const toolResults = await Promise.allSettled(
        connectedClients.map(async ({ name, client }) => {
          const toolSet = await this.getToolsWithTimeout(name, client);
          return { name, toolSet };
        })
      );

      for (const result of toolResults) {
        if (result.status !== "fulfilled" || !result.value.toolSet) {
          continue;
        }

        const { name, toolSet } = result.value;
        mcpTools[name] = toolSet;
        this.statuses.set(name, {
          name,
          status: "connected",
          toolCount: Object.keys(toolSet).length,
        });
      }

      const mergeResult = mergeMCPTools({
        localTools: {},
        mcpTools,
        onConflict: (conflict) => {
          console.warn(
            `[MCP] Tool name conflict: "${conflict.toolName}" from servers: ${conflict.sources.join(", ")}`
          );
        },
      });

      this.mergedTools = mergeResult.tools;
      this.mcpToolsByServer = mcpTools;
      this.initialized = true;
    } finally {
      this.initPromise = null;
    }
  }

  tools(): ToolSet {
    if (!this.initialized) {
      throw new Error("MCPManager not initialized. Call init() first.");
    }

    return this.mergedTools;
  }

  status(): MCPServerStatus[] {
    return Array.from(this.statuses.values()).map((entry) => ({ ...entry }));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.initialized = false;
    this.initPromise = null;

    await Promise.allSettled(
      this.clients.map(async ({ name, client }) => {
        try {
          await client.close();
          const status = this.statuses.get(name);
          if (status) {
            this.statuses.set(name, { ...status, status: "closed" });
          }
        } catch {
          return;
        }
      })
    );

    this.clients = [];
    this.mergedTools = {};
    this.mcpToolsByServer = {};
  }

  private async connectServer(
    name: string,
    config: MCPServerConfig
  ): Promise<MCPClient> {
    if (isStdioConfig(config)) {
      const transport = new Experimental_StdioMCPTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });

      return await createMCPClient({
        transport,
        onUncaughtError: (error) => {
          this.options.onError?.(name, error);
        },
      });
    }

    return await createMCPClient({
      transport: {
        type: config.type ?? "http",
        url: config.url,
        headers: config.headers,
      },
      onUncaughtError: (error) => {
        this.options.onError?.(name, error);
      },
    });
  }

  private async getToolsWithTimeout(
    name: string,
    client: MCPClient
  ): Promise<ToolSet | null> {
    const timeout = this.options.toolsTimeout ?? DEFAULT_TOOLS_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error(`Tools fetch timed out after ${timeout}ms`));
        });
      });

      const tools = await Promise.race([client.tools(), timeoutPromise]);
      return tools as ToolSet;
    } catch (error) {
      this.recordFailure(name, error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private recordFailure(name: string, error: unknown): void {
    this.statuses.set(name, {
      name,
      status: "failed",
      toolCount: 0,
      error: String(error),
    });
    this.options.onError?.(name, error);
  }
}
