import type { ToolSet } from "ai";

export interface ToolDefinition {
  description: string;
  name: string;
  parameters: unknown;
}

export interface ToolSource {
  callTool(name: string, args: unknown): Promise<unknown>;
  close?(): Promise<void>;
  listTools(): Promise<ToolDefinition[]> | ToolDefinition[];
}

export type ToolSourceBackedToolSet = ToolSet;
