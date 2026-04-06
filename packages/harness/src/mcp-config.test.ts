import { beforeEach, describe, expect, it, vi } from "vitest";

const INVALID_CONFIG_ERROR_PATTERN = /Invalid \.mcp\.json:/;
const DEFAULT_CONFIG_PATH_PATTERN = /[\\/]\.mcp\.json$/;

const { readFileMock } = vi.hoisted(() => {
  const mock = vi.fn();
  return { readFileMock: mock };
});

vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
}));

import { isRemoteConfig, isStdioConfig, loadMCPConfig } from "./mcp-config";

describe("loadMCPConfig", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it("parses a valid stdio config", async () => {
    const validConfig = {
      mcpServers: {
        filesystem: {
          command: "node",
          args: ["server.js", "--stdio"],
          env: {
            NODE_ENV: "test",
          },
        },
      },
    };

    readFileMock.mockResolvedValueOnce(JSON.stringify(validConfig));

    const result = await loadMCPConfig();
    const config = result.mcpServers.filesystem;

    expect(config).toEqual(validConfig.mcpServers.filesystem);
    expect(isStdioConfig(config)).toBe(true);
    expect(isRemoteConfig(config)).toBe(false);
  });

  it("parses a valid HTTP config with headers", async () => {
    const validConfig = {
      mcpServers: {
        remote: {
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer token",
          },
        },
      },
    };

    readFileMock.mockResolvedValueOnce(JSON.stringify(validConfig));

    const result = await loadMCPConfig();
    const config = result.mcpServers.remote;

    expect(config).toEqual({
      ...validConfig.mcpServers.remote,
      type: "http",
    });
    expect(isRemoteConfig(config)).toBe(true);
    expect(isStdioConfig(config)).toBe(false);
  });

  it("parses a valid SSE config with explicit sse transport type", async () => {
    const validConfig = {
      mcpServers: {
        events: {
          url: "https://example.com/sse",
          type: "sse",
        },
      },
    };

    readFileMock.mockResolvedValueOnce(JSON.stringify(validConfig));

    const result = await loadMCPConfig();

    expect(result).toEqual(validConfig);
    expect(isRemoteConfig(result.mcpServers.events)).toBe(true);
  });

  it("defaults remote transport type to http when not specified", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "https://example.com/mcp",
          },
        },
      })
    );

    const result = await loadMCPConfig();

    expect(result.mcpServers.remote).toEqual({
      url: "https://example.com/mcp",
      type: "http",
    });
  });

  it("parses mixed server configs", async () => {
    const validConfig = {
      mcpServers: {
        filesystem: {
          command: "node",
          args: ["server.js"],
        },
        httpServer: {
          url: "https://example.com/http",
          type: "http",
          headers: {
            "x-api-key": "secret",
          },
        },
        sseServer: {
          url: "https://example.com/sse",
          type: "sse",
        },
      },
    };

    readFileMock.mockResolvedValueOnce(JSON.stringify(validConfig));

    const result = await loadMCPConfig();

    expect(result).toEqual(validConfig);
  });

  it("returns empty config when file is missing", async () => {
    readFileMock.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })
    );

    const result = await loadMCPConfig({
      configPath: "/nonexistent/.mcp.json",
    });

    expect(result).toEqual({ mcpServers: {} });
  });

  it("throws a descriptive error for malformed JSON", async () => {
    readFileMock.mockResolvedValueOnce("{ invalid json");

    await expect(loadMCPConfig()).rejects.toThrow(INVALID_CONFIG_ERROR_PATTERN);
  });

  it("throws a validation error when a server has neither command nor url", async () => {
    const invalidConfig = {
      mcpServers: {
        broken: {
          headers: {
            Authorization: "Bearer token",
          },
        },
      },
    };

    readFileMock.mockResolvedValueOnce(JSON.stringify(invalidConfig));

    await expect(loadMCPConfig()).rejects.toThrow(INVALID_CONFIG_ERROR_PATTERN);
  });

  it("ignores unknown extra fields at the root and server level", async () => {
    const configWithExtras = {
      mcpServers: {
        filesystem: {
          command: "node",
          args: ["server.js"],
          extraField: "ignored",
        },
      },
      version: 1,
    };

    readFileMock.mockResolvedValueOnce(JSON.stringify(configWithExtras));

    const result = await loadMCPConfig();

    expect(result).toMatchObject({
      mcpServers: {
        filesystem: {
          command: "node",
          args: ["server.js"],
        },
      },
      version: 1,
    });
    expect(result.mcpServers.filesystem).not.toHaveProperty("extraField");
  });

  it("accepts an empty mcpServers object", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ mcpServers: {} }));

    await expect(loadMCPConfig()).resolves.toEqual({ mcpServers: {} });
  });

  it("reads from a custom config path override", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ mcpServers: {} }));

    await loadMCPConfig({ configPath: "/tmp/custom.mcp.json" });

    expect(readFileMock).toHaveBeenCalledWith("/tmp/custom.mcp.json", "utf-8");
  });

  it("uses process.cwd()/.mcp.json by default", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ mcpServers: {} }));

    await loadMCPConfig();

    expect(readFileMock).toHaveBeenCalledWith(
      expect.stringMatching(DEFAULT_CONFIG_PATH_PATTERN),
      "utf-8"
    );
  });
});
