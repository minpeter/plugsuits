import type { ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { managerCloseMock, managerInitMock, managerToolsByServerMock } =
  vi.hoisted(() => ({
    managerCloseMock: vi.fn(),
    managerInitMock: vi.fn(),
    managerToolsByServerMock: vi.fn(),
  }));

vi.mock("./mcp-config.js", () => ({
  loadMCPConfig: vi.fn(),
  isRemoteConfig: vi.fn(),
  isStdioConfig: vi.fn(),
}));

vi.mock("./mcp-tool-merger.js", () => ({
  mergeMCPTools: vi.fn(),
}));

vi.mock("./mcp-manager.js", () => ({
  MCPManager: class MockMCPManager {
    close = managerCloseMock;
    init = managerInitMock;
    toolsByServer = managerToolsByServerMock;
  },
}));

import { loadMCPConfig } from "./mcp-config.js";
import { clearMCPCache, resolveMCPOption } from "./mcp-init.js";
import { MCPManager } from "./mcp-manager.js";
import { mergeMCPTools } from "./mcp-tool-merger.js";
import type { MCPServerConfig } from "./mcp-types.js";

const loadMCPConfigMock = vi.mocked(loadMCPConfig);
const mergeMCPToolsMock = vi.mocked(mergeMCPTools);

describe("resolveMCPOption", () => {
  const localTools = {
    local_tool: { description: "local" },
  } as unknown as ToolSet;

  const mergedTools = {
    merged_tool: { description: "merged" },
  } as unknown as ToolSet;

  beforeEach(() => {
    clearMCPCache();
    vi.clearAllMocks();

    loadMCPConfigMock.mockResolvedValue({
      mcpServers: {
        remote: { url: "http://example.com" },
      },
    });
    managerInitMock.mockResolvedValue(undefined);
    managerToolsByServerMock.mockReturnValue({
      remote: { mcp_tool: { description: "mcp" } },
    });
    managerCloseMock.mockResolvedValue(undefined);
    mergeMCPToolsMock.mockReturnValue({ conflicts: [], tools: mergedTools });
  });

  it("creates manager for mcp=true, initializes it, and merges tools", async () => {
    const result = await resolveMCPOption(true, localTools);

    expect(loadMCPConfigMock).toHaveBeenCalledWith();
    expect(managerInitMock).toHaveBeenCalledTimes(1);
    expect(mergeMCPToolsMock).toHaveBeenCalledWith({
      localTools,
      mcpTools: {
        remote: { mcp_tool: { description: "mcp" } },
      },
    });
    expect(result.tools).toBe(mergedTools);
  });

  it("returns local tools when mcp=true and config file is missing", async () => {
    loadMCPConfigMock.mockResolvedValueOnce({ mcpServers: {} });

    const result = await resolveMCPOption(true, localTools);

    expect(managerInitMock).not.toHaveBeenCalled();
    expect(mergeMCPToolsMock).not.toHaveBeenCalled();
    expect(result.tools).toBe(localTools);
    await result.close();
  });

  it("uses inline servers when mcp is an MCPServerConfig array", async () => {
    const servers: MCPServerConfig[] = [{ url: "http://test.com" }];

    await resolveMCPOption(servers, localTools);

    expect(managerInitMock).toHaveBeenCalledTimes(1);
    expect(mergeMCPToolsMock).toHaveBeenCalledTimes(1);
  });

  it("combines config and inline servers when both are provided", async () => {
    await resolveMCPOption(
      {
        config: true,
        servers: [{ url: "http://inline.com" }],
      },
      localTools
    );

    expect(loadMCPConfigMock).toHaveBeenCalledWith(undefined);
    expect(managerInitMock).toHaveBeenCalledTimes(1);
    expect(mergeMCPToolsMock).toHaveBeenCalledTimes(1);
  });

  it("uses provided MCPManager instance and returns no-op close", async () => {
    const manager = new MCPManager();
    vi.mocked(manager.toolsByServer).mockReturnValue({
      provided: {
        provided_tool: {
          description: "provided",
        } as unknown as ToolSet[string],
      },
    });

    const result = await resolveMCPOption(manager, localTools);

    expect(manager.toolsByServer).toHaveBeenCalledTimes(1);
    expect(mergeMCPToolsMock).toHaveBeenCalledWith({
      localTools,
      mcpTools: {
        provided: { provided_tool: { description: "provided" } },
      },
    });
    await result.close();
    expect(managerCloseMock).not.toHaveBeenCalled();
  });

  it("reuses manager for repeated mcp=true config and initializes once", async () => {
    await resolveMCPOption(true, localTools);
    await resolveMCPOption(true, localTools);

    expect(managerInitMock).toHaveBeenCalledTimes(1);
  });

  it("keeps manager alive until all shared users close", async () => {
    const first = await resolveMCPOption(true, localTools);
    const second = await resolveMCPOption(true, localTools);

    await first.close();

    expect(managerCloseMock).not.toHaveBeenCalled();

    await second.close();

    expect(managerCloseMock).toHaveBeenCalledTimes(1);
  });

  it("closes manager when refcount reaches zero", async () => {
    const first = await resolveMCPOption(true, localTools);
    const second = await resolveMCPOption(true, localTools);

    await second.close();
    expect(managerCloseMock).not.toHaveBeenCalled();

    await first.close();
    expect(managerCloseMock).toHaveBeenCalledTimes(1);
  });

  it("makes cached close idempotent", async () => {
    const result = await resolveMCPOption(true, localTools);

    await result.close();
    await result.close();

    expect(managerCloseMock).toHaveBeenCalledTimes(1);
  });

  it("builds stable cache key for inline servers regardless of property order", async () => {
    const firstServers: MCPServerConfig[] = [
      {
        headers: { authorization: "Bearer token" },
        type: "http",
        url: "http://test.com",
      },
    ];
    const secondServers: MCPServerConfig[] = [
      {
        url: "http://test.com",
        type: "http",
        headers: { authorization: "Bearer token" },
      },
    ];

    await resolveMCPOption(firstServers, localTools);
    await resolveMCPOption(secondServers, localTools);

    expect(managerInitMock).toHaveBeenCalledTimes(1);
  });
});
