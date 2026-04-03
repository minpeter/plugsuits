import { describe, expect, it } from "vitest";
import {
  buildContextManagementConfig,
  isContextManagementSupported,
} from "./api-context-management";

describe("api-context-management", () => {
  describe("buildContextManagementConfig", () => {
    it("builds default edits from context limit", () => {
      expect(
        buildContextManagementConfig({
          contextLimit: 100_000,
        })
      ).toEqual({
        edits: [
          {
            type: "clear_tool_results",
            trigger: { type: "input_tokens", value: 80_000 },
            keep: { type: "input_tokens", value: 40_000 },
          },
          {
            type: "clear_thinking",
            trigger: { type: "input_tokens", value: 80_000 },
            keep: { type: "thinking_turns", value: 1 },
          },
        ],
      });
    });

    it("applies custom tool name filtering", () => {
      const clearableToolNames = ["grep", "glob"];
      const excludeToolNames = ["edit_file"];

      const config = buildContextManagementConfig({
        contextLimit: 50_000,
        clearableToolNames,
        excludeToolNames,
        clearThinking: false,
      });

      expect(config).toEqual({
        edits: [
          {
            type: "clear_tool_results",
            trigger: { type: "input_tokens", value: 40_000 },
            keep: { type: "input_tokens", value: 20_000 },
            clearToolNames: ["grep", "glob"],
            excludeToolNames: ["edit_file"],
          },
        ],
      });
      expect(config.edits[0]?.clearToolNames).not.toBe(clearableToolNames);
      expect(config.edits[0]?.excludeToolNames).not.toBe(excludeToolNames);
    });

    it("calculates threshold values and keeps trigger >= keep", () => {
      const roundedDefaults = buildContextManagementConfig({
        contextLimit: 20_001,
      });
      expect(roundedDefaults.edits[0]?.keep).toEqual({
        type: "input_tokens",
        value: 8000,
      });
      expect(roundedDefaults.edits[0]?.trigger).toEqual({
        type: "input_tokens",
        value: 16_000,
      });

      const clampedTrigger = buildContextManagementConfig({
        contextLimit: 20_000,
        targetInputTokens: 9000,
        triggerInputTokens: 7000,
      });
      expect(clampedTrigger.edits[0]?.keep?.value).toBe(9000);
      expect(clampedTrigger.edits[0]?.trigger?.value).toBe(9000);
    });

    it("handles edge cases for zero context and empty tool filters", () => {
      expect(
        buildContextManagementConfig({
          contextLimit: 0,
          clearableToolNames: [],
          excludeToolNames: [],
          clearThinking: false,
        })
      ).toEqual({
        edits: [
          {
            type: "clear_tool_results",
            trigger: { type: "input_tokens", value: 0 },
            keep: { type: "input_tokens", value: 0 },
            clearToolNames: [],
            excludeToolNames: [],
          },
        ],
      });
    });
  });

  describe("isContextManagementSupported", () => {
    it("returns true for top-level provider flag", () => {
      expect(
        isContextManagementSupported({
          contextManagement: true,
        })
      ).toBe(true);
    });

    it("returns true for nested capabilities/provider metadata flags", () => {
      expect(
        isContextManagementSupported({
          capabilities: {
            supportsContextManagement: true,
          },
        })
      ).toBe(true);

      expect(
        isContextManagementSupported({
          anthropic: {
            contextManagement: {
              supported: true,
            },
          },
        })
      ).toBe(true);
    });

    it("returns false when no support flag exists", () => {
      expect(isContextManagementSupported()).toBe(false);
      expect(
        isContextManagementSupported({
          supportsContextManagement: false,
        })
      ).toBe(false);
      expect(
        isContextManagementSupported({
          capabilities: {
            contextManagement: {
              supported: false,
            },
          },
        })
      ).toBe(false);
    });
  });
});
