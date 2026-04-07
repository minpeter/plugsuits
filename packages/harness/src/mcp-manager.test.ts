import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOT_INITIALIZED_ERROR_PATTERN = /not initialized/i;
const CLOSED_ERROR_PATTERN = /closed/i;

const {
  createMCPClientMock,
  stdioTransportMock,
  loadMCPConfigMock,
  isStdioConfigMock,
  mergeMCPToolsMock,
  timeoutSpy,
  clearTimeoutSpy,
} = vi.hoisted(() => ({
  createMCPClientMock: vi.fn(),
  stdioTransportMock: vi.fn().mockImplementation((options) => options),
  loadMCPConfigMock: vi.fn(),
  isStdioConfigMock: vi.fn(),
  mergeMCPToolsMock: vi.fn(),
  timeoutSpy: vi.fn((callback: () => void) => {
    const handle = { cancelled: false };
    Promise.resolve().then(() => {
      if (!handle.cancelled) {
        callback();
      }
    });
    return handle;
  }),
  clearTimeoutSpy: vi.fn((handle: { cancelled?: boolean }) => {
    if (handle) {
      handle.cancelled = true;
    }
  }),
}));

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: createMCPClientMock,
}));

vi.mock("@ai-sdk/mcp/mcp-stdio", () => ({
  Experimental_StdioMCPTransport: stdioTransportMock,
}));

vi.mock("./mcp-config.js", () => ({
  loadMCPConfig: loadMCPConfigMock,
  isStdioConfig: isStdioConfigMock,
}));

vi.mock("./mcp-tool-merger.js", () => ({
  mergeMCPTools: mergeMCPToolsMock,
}));

import { MCPManager } from "./mcp-manager";

function createToolSet(...names: string[]): ToolSet {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        description: `${name} description`,
        parameters: {},
      } as unknown as ToolSet[string],
    ])
  );
}

function createMockClient(toolsResult: Promise<ToolSet> | ToolSet = {}): {
  tools: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    tools:
      toolsResult instanceof Promise
        ? vi.fn().mockReturnValue(toolsResult)
        : vi.fn().mockResolvedValue(toolsResult),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("MCPManager", () => {
  beforeEach(() => {
    createMCPClientMock.mockReset();
    stdioTransportMock.mockReset();
    loadMCPConfigMock.mockReset();
    isStdioConfigMock.mockReset();
    mergeMCPToolsMock.mockReset();
    timeoutSpy.mockClear();
    clearTimeoutSpy.mockClear();

    vi.stubGlobal("setTimeout", timeoutSpy as unknown as typeof setTimeout);
    vi.stubGlobal(
      "clearTimeout",
      clearTimeoutSpy as unknown as typeof clearTimeout
    );

    loadMCPConfigMock.mockResolvedValue({ mcpServers: {} });
    isStdioConfigMock.mockImplementation(
      (config: { command?: string }) => "command" in config
    );
    mergeMCPToolsMock.mockImplementation(({ localTools, mcpTools }) => ({
      tools: {
        ...localTools,
        ...Object.assign({}, ...Object.values(mcpTools)),
      },
      conflicts: [],
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("init() with valid config connects all servers, and tools() returns merged ToolSet", async () => {
    const alphaTools = createToolSet("alpha_tool");
    const betaTools = createToolSet("beta_tool");
    const alphaClient = createMockClient(alphaTools);
    const betaClient = createMockClient(betaTools);

    loadMCPConfigMock.mockResolvedValue({
      mcpServers: {
        alpha: { url: "https://alpha.example.com/mcp" },
        beta: { command: "beta-server", args: ["--stdio"] },
      },
    });
    createMCPClientMock
      .mockResolvedValueOnce(alphaClient)
      .mockResolvedValueOnce(betaClient);
    mergeMCPToolsMock.mockReturnValue({
      tools: { ...alphaTools, ...betaTools },
      conflicts: [],
    });

    const manager = new MCPManager();
    await manager.init();

    expect(createMCPClientMock).toHaveBeenCalledTimes(2);
    expect(stdioTransportMock).toHaveBeenCalledTimes(1);
    expect(manager.tools()).toEqual({ ...alphaTools, ...betaTools });
    expect(manager.status()).toEqual([
      { name: "alpha", status: "connected", toolCount: 1 },
      { name: "beta", status: "connected", toolCount: 1 },
    ]);
  });

  it("init() with one failing server warns via onError, connects others, and returns partial ToolSet", async () => {
    const onError = vi.fn();
    const alphaTools = createToolSet("alpha_tool");
    const alphaClient = createMockClient(alphaTools);
    const failure = new Error("connect failed");

    loadMCPConfigMock.mockResolvedValue({
      mcpServers: {
        alpha: { url: "https://alpha.example.com/mcp" },
        beta: { url: "https://beta.example.com/mcp" },
      },
    });
    createMCPClientMock
      .mockResolvedValueOnce(alphaClient)
      .mockRejectedValueOnce(failure);
    mergeMCPToolsMock.mockReturnValue({ tools: alphaTools, conflicts: [] });

    const manager = new MCPManager({ onError });
    await manager.init();

    expect(onError).toHaveBeenCalledWith("beta", failure);
    expect(manager.tools()).toEqual(alphaTools);
    expect(manager.status()).toEqual([
      {
        name: "beta",
        status: "failed",
        toolCount: 0,
        error: failure.toString(),
      },
      { name: "alpha", status: "connected", toolCount: 1 },
    ]);
  });

  it("init() with all servers failing leaves tools() empty without throwing", async () => {
    const failureA = new Error("alpha down");
    const failureB = new Error("beta down");

    loadMCPConfigMock.mockResolvedValue({
      mcpServers: {
        alpha: { url: "https://alpha.example.com/mcp" },
        beta: { command: "beta-server" },
      },
    });
    createMCPClientMock
      .mockRejectedValueOnce(failureA)
      .mockRejectedValueOnce(failureB);
    mergeMCPToolsMock.mockReturnValue({ tools: {}, conflicts: [] });

    const manager = new MCPManager();
    await manager.init();

    expect(manager.tools()).toEqual({});
    expect(manager.status()).toEqual([
      {
        name: "alpha",
        status: "failed",
        toolCount: 0,
        error: failureA.toString(),
      },
      {
        name: "beta",
        status: "failed",
        toolCount: 0,
        error: failureB.toString(),
      },
    ]);
  });

  it("init() called twice returns immediately without double connect", async () => {
    const client = createMockClient(createToolSet("alpha_tool"));

    loadMCPConfigMock.mockResolvedValue({
      mcpServers: {
        alpha: { url: "https://alpha.example.com/mcp" },
      },
    });
    createMCPClientMock.mockResolvedValue(client);
    mergeMCPToolsMock.mockReturnValue({
      tools: createToolSet("alpha_tool"),
      conflicts: [],
    });

    const manager = new MCPManager();
    await manager.init();
    await manager.init();

    expect(createMCPClientMock).toHaveBeenCalledTimes(1);
  });

  it("init() shares an in-flight initialization promise across concurrent callers", async () => {
    let resolveTools: ((value: ToolSet) => void) | undefined;
    const client = createMockClient(
      new Promise<ToolSet>((resolve) => {
        resolveTools = resolve;
      })
    );

    loadMCPConfigMock.mockResolvedValue({
      mcpServers: {
        alpha: { url: "https://alpha.example.com/mcp" },
      },
    });
    createMCPClientMock.mockResolvedValue(client);
    mergeMCPToolsMock.mockReturnValue({
      tools: createToolSet("alpha_tool"),
      conflicts: [],
    });

    const manager = new MCPManager();
    const firstInit = manager.init();
    const secondInit = manager.init();

    expect(firstInit).toBe(secondInit);
    resolveTools?.(createToolSet("alpha_tool"));
    await Promise.all([firstInit, secondInit]);

    expect(createMCPClientMock).toHaveBeenCalledTimes(1);
  });

  it("init() rejects after close() has been called", async () => {
    const manager = new MCPManager();

    await manager.close();

    await expect(manager.init()).rejects.toThrow(CLOSED_ERROR_PATTERN);
  });

  it("init() with no .mcp.json returns empty tools without error", async () => {
    loadMCPConfigMock.mockResolvedValue({ mcpServers: {} });
    mergeMCPToolsMock.mockReturnValue({ tools: {}, conflicts: [] });

    const manager = new MCPManager();
    await manager.init();

    expect(manager.tools()).toEqual({});
    expect(manager.status()).toEqual([]);
  });

  it("close() closes all clients", async () => {
    const alphaClient = createMockClient(createToolSet("alpha_tool"));
    const betaClient = createMockClient(createToolSet("beta_tool"));

    loadMCPConfigMock.mockResolvedValue({
      mcpServers: {
        alpha: { url: "https://alpha.example.com/mcp" },
        beta: { command: "beta-server" },
      },
    });
    createMCPClientMock
      .mockResolvedValueOnce(alphaClient)
      .mockResolvedValueOnce(betaClient);
    mergeMCPToolsMock.mockReturnValue({
      tools: { ...createToolSet("alpha_tool"), ...createToolSet("beta_tool") },
      conflicts: [],
    });

    const manager = new MCPManager();
    await manager.init();
    await manager.close();

    expect(alphaClient.close).toHaveBeenCalledTimes(1);
    expect(betaClient.close).toHaveBeenCalledTimes(1);
    expect(manager.status()).toEqual([
      { name: "alpha", status: "closed", toolCount: 1 },
      { name: "beta", status: "closed", toolCount: 1 },
    ]);
  });

  it("close() called twice is idempotent", async () => {
    const client = createMockClient(createToolSet("alpha_tool"));

    loadMCPConfigMock.mockResolvedValue({
      mcpServers: {
        alpha: { url: "https://alpha.example.com/mcp" },
      },
    });
    createMCPClientMock.mockResolvedValue(client);
    mergeMCPToolsMock.mockReturnValue({
      tools: createToolSet("alpha_tool"),
      conflicts: [],
    });

    const manager = new MCPManager();
    await manager.init();
    await manager.close();
    await manager.close();

    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("close() before init() does not throw", async () => {
    const manager = new MCPManager();

    await expect(manager.close()).resolves.toBeUndefined();
  });

  it("status() returns array of MCPServerStatus per server", async () => {
    const alphaClient = createMockClient(
      createToolSet("alpha_tool", "alpha_tool_two")
    );
    const betaClient = createMockClient(createToolSet("beta_tool"));

    loadMCPConfigMock.mockResolvedValue({
      mcpServers: {
        alpha: { url: "https://alpha.example.com/mcp" },
        beta: { url: "https://beta.example.com/mcp" },
      },
    });
    createMCPClientMock
      .mockResolvedValueOnce(alphaClient)
      .mockResolvedValueOnce(betaClient);
    mergeMCPToolsMock.mockReturnValue({ tools: {}, conflicts: [] });

    const manager = new MCPManager();
    await manager.init();

    expect(manager.status()).toEqual([
      { name: "alpha", status: "connected", toolCount: 2 },
      { name: "beta", status: "connected", toolCount: 1 },
    ]);
  });

  it("toolsByServer() returns per-server tool sets after init", async () => {
    const alphaTools = createToolSet("alpha_tool");
    const betaTools = createToolSet("beta_tool");
    const alphaClient = createMockClient(alphaTools);
    const betaClient = createMockClient(betaTools);

    loadMCPConfigMock.mockResolvedValue({
      mcpServers: {
        alpha: { url: "https://alpha.example.com/mcp" },
        beta: { url: "https://beta.example.com/mcp" },
      },
    });
    createMCPClientMock
      .mockResolvedValueOnce(alphaClient)
      .mockResolvedValueOnce(betaClient);
    mergeMCPToolsMock.mockReturnValue({
      tools: { ...alphaTools, ...betaTools },
      conflicts: [],
    });

    const manager = new MCPManager();
    await manager.init();

    expect(manager.toolsByServer()).toEqual({
      alpha: alphaTools,
      beta: betaTools,
    });
  });

  it("tools() before init() throws error containing not initialized", () => {
    const manager = new MCPManager();

    expect(() => manager.tools()).toThrow(NOT_INITIALIZED_ERROR_PATTERN);
  });

  it("transport timeout aborts tool loading after toolsTimeout and skips server", async () => {
    const onError = vi.fn();
    const neverResolvingTools = new Promise<ToolSet>(() => undefined);
    const client = createMockClient(neverResolvingTools);

    loadMCPConfigMock.mockResolvedValue({
      mcpServers: {
        alpha: { url: "https://alpha.example.com/mcp" },
      },
    });
    createMCPClientMock.mockResolvedValue(client);
    mergeMCPToolsMock.mockReturnValue({ tools: {}, conflicts: [] });

    const manager = new MCPManager({ onError, toolsTimeout: 5 });
    await manager.init();

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(manager.status()).toEqual([
      {
        name: "alpha",
        status: "failed",
        toolCount: 0,
        error: expect.stringContaining("timed out"),
      },
    ]);
  });

  it("onError callback is invoked when tools() fetch fails", async () => {
    const onError = vi.fn();
    const failure = new Error("tools failed");
    const client = {
      tools: vi.fn().mockRejectedValue(failure),
      close: vi.fn().mockResolvedValue(undefined),
    };

    loadMCPConfigMock.mockResolvedValue({
      mcpServers: {
        alpha: { url: "https://alpha.example.com/mcp" },
      },
    });
    createMCPClientMock.mockResolvedValue(client);
    mergeMCPToolsMock.mockReturnValue({ tools: {}, conflicts: [] });

    const manager = new MCPManager({ onError });
    await manager.init();

    expect(onError).toHaveBeenCalledWith("alpha", failure);
    expect(manager.status()).toEqual([
      {
        name: "alpha",
        status: "failed",
        toolCount: 0,
        error: failure.toString(),
      },
    ]);
  });
});
