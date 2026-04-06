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
  name: string;
  client: MCPClient;
}

export class MCPManager {
  private readonly options: MCPManagerOptions;
  private clients: ManagedClient[] = [];
  private mergedTools: ToolSet = {};
  private readonly statuses = new Map<string, MCPServerStatus>();
  private initialized = false;
  private initializing = false;
  private closed = false;

  constructor(options: MCPManagerOptions = {}) {
    this.options = options;
  }

  async init(): Promise<void> {
    if (this.initialized || this.initializing) {
      return;
    }

    this.initializing = true;
    this.closed = false;

    try {
      const config = await loadMCPConfig({
        configPath: this.options.configPath,
      });
      const serverEntries = Object.entries(config.mcpServers);
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

        const toolSet = await this.getToolsWithTimeout(serverName, client);
        if (!toolSet) {
          continue;
        }

        mcpTools[serverName] = toolSet;
        this.statuses.set(serverName, {
          name: serverName,
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
      this.initialized = true;
    } finally {
      this.initializing = false;
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
        type: "http",
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
