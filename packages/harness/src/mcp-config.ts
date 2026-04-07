import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type {
  MCPConfigFile,
  MCPRemoteServerConfig,
  MCPServerConfig,
  MCPStdioServerConfig,
} from "./mcp-types.js";

const INVALID_MCP_CONFIG_PREFIX = "Invalid .mcp.json:";

const MCPStdioServerConfigSchema = z
  .object({
    command: z.string().min(1, "command must not be empty"),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strip();

const MCPRemoteServerConfigSchema = z
  .object({
    url: z.string().url(),
    type: z.enum(["http", "sse"]).optional().default("http"),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strip();

const MCPServerConfigSchema = z.union([
  MCPStdioServerConfigSchema,
  MCPRemoteServerConfigSchema,
]);

const MCPConfigFileSchema = z
  .object({
    mcpServers: z.record(z.string(), MCPServerConfigSchema),
  })
  .passthrough();

export async function loadMCPConfig(options?: {
  configPath?: string;
}): Promise<MCPConfigFile> {
  const configPath = options?.configPath ?? join(process.cwd(), ".mcp.json");

  try {
    const content = await readFile(configPath, "utf-8");
    const parsed = parseMCPConfigContent(content);
    return MCPConfigFileSchema.parse(parsed) as MCPConfigFile;
  } catch (error) {
    if (isEnoentError(error)) {
      return { mcpServers: {} };
    }

    if (error instanceof z.ZodError) {
      throw new Error(
        `${INVALID_MCP_CONFIG_PREFIX} ${JSON.stringify(error.format(), null, 2)}`
      );
    }

    throw error;
  }
}

export function isStdioConfig(
  config: MCPServerConfig
): config is MCPStdioServerConfig {
  return "command" in config;
}

export function isRemoteConfig(
  config: MCPServerConfig
): config is MCPRemoteServerConfig {
  return "url" in config;
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function parseMCPConfigContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new z.ZodError([
      {
        code: "custom",
        message: "Invalid JSON in .mcp.json",
        path: [],
      },
    ]);
  }
}
