import type { ToolSet } from "ai";
import type { ToolSourceCallContext } from "./execution-context";

export interface ToolDefinition {
  description: string;
  name: string;
  parameters: unknown;
}

export interface ToolSource {
  callTool(
    name: string,
    args: unknown,
    context?: ToolSourceCallContext
  ): Promise<unknown>;
  close?(): Promise<void>;
  listTools(): Promise<ToolDefinition[]> | ToolDefinition[];
}

export type ToolSourceBackedToolSet = ToolSet;
