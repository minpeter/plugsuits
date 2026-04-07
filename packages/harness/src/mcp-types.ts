/**
 * @module mcp-types
 * Pure TypeScript type definitions for MCP client integration.
 * No runtime logic, no imports from @ai-sdk/mcp.
 */

import type { ToolSet } from "ai";

/**
 * Configuration for a stdio-based MCP server.
 * The server is launched as a subprocess with the given command and arguments.
 */
export interface MCPStdioServerConfig {
  /** Optional arguments to pass to the command */
  args?: string[];
  /** The executable command to run (e.g., "python", "node", "/usr/local/bin/my-server") */
  command: string;
  /** Optional environment variables to pass to the subprocess */
  env?: Record<string, string>;
}

/**
 * Configuration for an HTTP/SSE-based MCP server.
 * The server is accessed via HTTP at the given URL.
 */
export interface MCPRemoteServerConfig {
  /** Optional HTTP headers to include in requests (e.g., authorization, custom headers) */
  headers?: Record<string, string>;
  /** Transport type: 'http' (Streamable HTTP, default) or 'sse' (Server-Sent Events) */
  type?: "http" | "sse";
  /** The base URL of the remote MCP server (e.g., "http://localhost:3000", "https://api.example.com") */
  url: string;
}

/**
 * Configuration for an MCP server.
 * Discriminated union: either stdio (launches a subprocess) or remote (HTTP/SSE).
 */
export type MCPServerConfig = MCPStdioServerConfig | MCPRemoteServerConfig;

/**
 * MCP servers configuration file structure.
 * Typically stored as `.mcp.json` in the project root.
 */
export interface MCPConfigFile {
  /** Map of server names to their configurations */
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * Options for initializing and managing MCP servers.
 */
export interface MCPManagerOptions {
  /** Path to the MCP configuration file (e.g., "./.mcp.json" or "/etc/app/.mcp.json") */
  configPath?: string;
  /**
   * When true, always load file-based config even when inline `servers` are provided.
   * Use this when `configPath` is undefined (default `.mcp.json`) but file servers
   * should still be merged with inline servers.
   */
  loadFileConfig?: boolean;
  /** Optional callback for server errors (connection failures, crashes, etc.) */
  onError?: (server: string, error: unknown) => void;
  /** Inline server configurations merged with any file-based config */
  servers?: Record<string, MCPServerConfig>;
  /** Timeout (in milliseconds) for tool execution requests to MCP servers (default: 30000) */
  toolsTimeout?: number;
}

/**
 * Result of merging tools from multiple MCP servers.
 */
export interface MCPToolMergeResult {
  /** List of tool name conflicts detected during merge */
  conflicts: Array<{
    /** The conflicting tool name */
    toolName: string;
    /** List of server names that provided this tool */
    sources: string[];
  }>;
  /** Merged set of tools from all connected servers */
  tools: ToolSet;
}

/**
 * Status information for a connected MCP server.
 */
export interface MCPServerStatus {
  /** Error message if status is "failed" (e.g., connection refused, timeout) */
  error?: string;
  /** Name of the server (key in the MCP config) */
  name: string;
  /** Current connection state */
  status: "connected" | "failed" | "closed";
  /** Number of tools provided by this server */
  toolCount: number;
}
