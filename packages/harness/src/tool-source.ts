import type { ToolSet } from "ai";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ToolSource {
  listTools(): Promise<ToolDefinition[]> | ToolDefinition[];
  callTool(name: string, args: unknown): Promise<unknown>;
  close?(): Promise<void>;
}

export type ToolSourceBackedToolSet = ToolSet;
