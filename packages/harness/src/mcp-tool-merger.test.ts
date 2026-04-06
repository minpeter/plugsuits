import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { mergeMCPTools, sanitizeServerName } from "./mcp-tool-merger";

const mockTool = { description: "test", parameters: {} } as unknown as Tool;

describe("sanitizeServerName", () => {
  it("replaces special characters with underscores", () => {
    expect(sanitizeServerName("my-server.io")).toBe("my_server_io");
  });
});

describe("mergeMCPTools", () => {
  it("merges without conflicts when tool names are unique", () => {
    const localTools = { local_tool: mockTool };
    const mcpTools = {
      serverA: { remote_tool: mockTool },
      serverB: { another_remote_tool: mockTool },
    };

    const result = mergeMCPTools({ localTools, mcpTools });

    expect(result.tools).toEqual({
      local_tool: mockTool,
      remote_tool: mockTool,
      another_remote_tool: mockTool,
    });
    expect(result.conflicts).toEqual([]);
    expect(result.tools).not.toBe(localTools);
    expect(result.tools).not.toBe(mcpTools.serverA);
  });

  it("prefixes conflicting MCP tool when local tool has the same name", () => {
    const onConflict = vi.fn();

    const result = mergeMCPTools({
      localTools: { read_file: mockTool },
      mcpTools: { filesystem: { read_file: mockTool } },
      onConflict,
    });

    expect(result.tools).toEqual({
      read_file: mockTool,
      filesystem_read_file: mockTool,
    });
    expect(result.conflicts).toEqual([
      { toolName: "read_file", sources: ["local", "filesystem"] },
    ]);
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledWith({
      toolName: "read_file",
      sources: ["local", "filesystem"],
    });
  });

  it("prefixes both MCP tools when two servers expose the same tool name", () => {
    const onConflict = vi.fn();

    const result = mergeMCPTools({
      localTools: {},
      mcpTools: {
        github: { search: mockTool },
        gitlab: { search: mockTool },
      },
      onConflict,
    });

    expect(result.tools).toEqual({
      github_search: mockTool,
      gitlab_search: mockTool,
    });
    expect(result.conflicts).toEqual([
      { toolName: "search", sources: ["github", "gitlab"] },
    ]);
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledWith({
      toolName: "search",
      sources: ["github", "gitlab"],
    });
  });

  it("returns local tools unchanged when there are no MCP tools", () => {
    const localTools = { local_tool: mockTool };

    const result = mergeMCPTools({
      localTools,
      mcpTools: {},
    });

    expect(result.tools).toEqual({ local_tool: mockTool });
    expect(result.conflicts).toEqual([]);
    expect(result.tools).not.toBe(localTools);
  });

  it("returns MCP tools as-is when there are no local tools and no conflicts", () => {
    const result = mergeMCPTools({
      localTools: {},
      mcpTools: {
        alpha: { tool_one: mockTool },
        beta: { tool_two: mockTool },
      },
    });

    expect(result.tools).toEqual({
      tool_one: mockTool,
      tool_two: mockTool,
    });
    expect(result.conflicts).toEqual([]);
  });

  it("returns empty tools and conflicts for empty inputs", () => {
    const result = mergeMCPTools({
      localTools: {},
      mcpTools: {},
    });

    expect(result).toEqual({ tools: {}, conflicts: [] });
  });

  it("sanitizes server names before prefixing conflicting tool names", () => {
    const result = mergeMCPTools({
      localTools: { toolname: mockTool },
      mcpTools: {
        "my-server.io": { toolname: mockTool },
      },
    });

    expect(result.tools).toEqual({
      toolname: mockTool,
      my_server_io_toolname: mockTool,
    });
    expect(result.conflicts).toEqual([
      { toolName: "toolname", sources: ["local", "my-server.io"] },
    ]);
  });

  it("prefixes all conflicting tools and reports each conflict once", () => {
    const onConflict = vi.fn();

    const result = mergeMCPTools({
      localTools: {
        read_file: mockTool,
        list_dir: mockTool,
      },
      mcpTools: {
        filesystem: {
          read_file: mockTool,
          list_dir: mockTool,
          unique_tool: mockTool,
        },
        backup: {
          read_file: mockTool,
        },
      },
      onConflict,
    });

    expect(result.tools).toEqual({
      read_file: mockTool,
      list_dir: mockTool,
      filesystem_read_file: mockTool,
      filesystem_list_dir: mockTool,
      unique_tool: mockTool,
      backup_read_file: mockTool,
    });
    expect(result.conflicts).toEqual([
      {
        toolName: "read_file",
        sources: ["local", "filesystem", "backup"],
      },
      {
        toolName: "list_dir",
        sources: ["local", "filesystem"],
      },
    ]);
    expect(onConflict).toHaveBeenCalledTimes(2);
    expect(onConflict).toHaveBeenNthCalledWith(1, {
      toolName: "read_file",
      sources: ["local", "filesystem", "backup"],
    });
    expect(onConflict).toHaveBeenNthCalledWith(2, {
      toolName: "list_dir",
      sources: ["local", "filesystem"],
    });
  });

  it("adds numeric suffixes when sanitized server prefixes would collide", () => {
    const result = mergeMCPTools({
      localTools: { toolname: mockTool },
      mcpTools: {
        "my-server": { toolname: mockTool },
        my_server: { toolname: mockTool },
      },
    });

    expect(result.tools).toEqual({
      toolname: mockTool,
      my_server_toolname: mockTool,
      my_server_toolname_2: mockTool,
    });
    expect(result.conflicts).toEqual([
      { toolName: "toolname", sources: ["local", "my-server", "my_server"] },
    ]);
  });
});
